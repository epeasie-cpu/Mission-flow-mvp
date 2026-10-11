import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { AI_DRAFT_STAMP } from "../config/missionflow.config";
import { aiArtifact, aiVerification, document, documentVersion } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { Conflict, NotFound, ValidationError } from "./errors";
import { authorized } from "./policy";
import { mustTasker } from "./tasker-store";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function nextVersion(db: CoreDb, documentId: string): Promise<number> {
  const [latest] = await db
    .select({ versionNo: documentVersion.versionNo })
    .from(documentVersion)
    .where(eq(documentVersion.documentId, documentId))
    .orderBy(desc(documentVersion.versionNo))
    .limit(1);
  return (latest?.versionNo ?? 0) + 1;
}

async function assertHumanDerivation(db: CoreDb, derivedFromVersionId: string | null | undefined, authorType: "human" | "ai", body: string) {
  if (authorType === "ai") {
    if (!body.includes(AI_DRAFT_STAMP)) throw new ValidationError("AI text keeps its stamp");
    return;
  }
  if (!derivedFromVersionId) return;
  const [prior] = await db.select().from(documentVersion).where(eq(documentVersion.id, derivedFromVersionId)).limit(1);
  if (!prior || prior.authorType !== "ai" || !prior.aiArtifactId) return;
  const [verdict] = await db
    .select()
    .from(aiVerification)
    .where(and(eq(aiVerification.aiArtifactId, prior.aiArtifactId), eq(aiVerification.decision, "verified")))
    .limit(1);
  if (!verdict) throw new ValidationError("A human version derived from AI requires a verified artifact");
}

export async function uploadDocument(
  db: CoreDb,
  actor: Actor,
  taskerId: string,
  input: { enclave: "original" | "supporting" | "draft" | "coordination" | "final"; title: string; bodyMd: string },
) {
  return authorized(db, actor, "docs.upload", { taskerId }, async (tx) => {
    await mustTasker(tx, taskerId);
    if (actor.type !== "user") throw new ValidationError("A person uploads a document");
    if (input.enclave === "final" && actor.type !== "user") throw new ValidationError("The final enclave is human-authored");
    const [doc] = await tx
      .insert(document)
      .values({ taskerId, enclave: input.enclave, title: input.title })
      .returning();
    const [version] = await tx
      .insert(documentVersion)
      .values({
        documentId: doc!.id,
        versionNo: 1,
        bodyMd: input.bodyMd,
        sha256: sha256(input.bodyMd),
        authorType: "human",
        authorUserId: actor.userId,
      })
      .returning();
    await writeAudit(tx, actor, {
      eventType: "document.uploaded",
      entityType: "document",
      entityId: doc!.id,
      taskerId,
      payload: { enclave: input.enclave, version_id: version!.id },
    });
    return { document: doc!, version: version! };
  });
}

export async function createVersion(
  db: CoreDb,
  actor: Actor,
  documentId: string,
  input: { bodyMd: string; authorType?: "human" | "ai"; aiArtifactId?: string | null; derivedFromVersionId?: string | null },
) {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) throw new NotFound("document");
  return authorized(db, actor, "docs.version", { taskerId: doc.taskerId }, async (tx) => {
    if (actor.type !== "user") throw new ValidationError("A person writes a version");
    const [current] = await tx.select().from(document).where(eq(document.id, documentId)).limit(1);
    if (!current) throw new NotFound("document");
    if (current.locked) throw new ValidationError("The document is locked");
    if (current.checkedOutBy && current.checkedOutBy !== actor.userId) throw new Conflict("Checked out by someone else");
    const authorType = input.authorType ?? "human";
    if (current.enclave === "final" && authorType === "ai") throw new ValidationError("The final enclave rejects AI-authored versions");
    await assertHumanDerivation(tx, input.derivedFromVersionId, authorType, input.bodyMd);
    if (authorType === "ai" && !input.aiArtifactId) throw new ValidationError("An AI version cites its artifact");
    if (authorType === "ai" && input.aiArtifactId) {
      const [artifact] = await tx.select().from(aiArtifact).where(eq(aiArtifact.id, input.aiArtifactId)).limit(1);
      if (!artifact || artifact.taskerId !== current.taskerId) throw new ValidationError("Artifact is not for this tasker");
    }
    const [version] = await tx
      .insert(documentVersion)
      .values({
        documentId,
        versionNo: await nextVersion(tx, documentId),
        bodyMd: input.bodyMd,
        sha256: sha256(input.bodyMd),
        authorType,
        authorUserId: authorType === "human" ? actor.userId : null,
        aiArtifactId: input.aiArtifactId ?? null,
        derivedFromVersionId: input.derivedFromVersionId ?? null,
      })
      .returning();
    await writeAudit(tx, actor, {
      eventType: "document.version_created",
      entityType: "document_version",
      entityId: version!.id,
      taskerId: current.taskerId,
      payload: { author_type: authorType },
    });
    if (authorType === "ai" && input.aiArtifactId) {
      await writeAudit(tx, { type: "ai", requestedBy: actor.userId }, {
        eventType: "ai.artifact_used_in_version",
        entityType: "document_version",
        entityId: version!.id,
        taskerId: current.taskerId,
        aiArtifactId: input.aiArtifactId,
        payload: { requested_by: actor.userId },
      });
    }
    return version!;
  });
}

export async function checkout(db: CoreDb, actor: Actor, documentId: string) {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) throw new NotFound("document");
  return authorized(db, actor, "docs.checkout", { taskerId: doc.taskerId }, async (tx) => {
    if (actor.type !== "user") throw new ValidationError("A person checks out a document");
    const [current] = await tx.select().from(document).where(eq(document.id, documentId)).limit(1);
    if (!current) throw new NotFound("document");
    if (current.locked) throw new ValidationError("The document is locked");
    if (current.checkedOutBy && current.checkedOutBy !== actor.userId) throw new Conflict("Checked out by someone else");
    const [updated] = await tx
      .update(document)
      .set({ checkedOutBy: actor.userId, checkedOutAt: new Date() })
      .where(eq(document.id, documentId))
      .returning();
    await writeAudit(tx, actor, {
      eventType: "document.checked_out",
      entityType: "document",
      entityId: documentId,
      taskerId: current.taskerId,
      payload: {},
    });
    return updated!;
  });
}

export async function checkin(db: CoreDb, actor: Actor, documentId: string) {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) throw new NotFound("document");
  return authorized(db, actor, "docs.checkout", { taskerId: doc.taskerId }, async (tx) => {
    if (actor.type !== "user") throw new ValidationError("A person checks in a document");
    const [updated] = await tx
      .update(document)
      .set({ checkedOutBy: null, checkedOutAt: null })
      .where(and(eq(document.id, documentId), eq(document.checkedOutBy, actor.userId)))
      .returning();
    if (!updated) throw new Conflict("You do not hold the checkout");
    await writeAudit(tx, actor, {
      eventType: "document.checked_in",
      entityType: "document",
      entityId: documentId,
      taskerId: doc.taskerId,
      payload: {},
    });
    return updated;
  });
}

export async function lockFinal(db: CoreDb, actor: Actor, documentId: string) {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) throw new NotFound("document");
  return authorized(db, actor, "docs.lock", { taskerId: doc.taskerId }, async (tx) => {
    if (doc.enclave !== "final") throw new ValidationError("Only the final enclave locks");
    const [updated] = await tx
      .update(document)
      .set({ locked: true, checkedOutBy: null, checkedOutAt: null })
      .where(eq(document.id, documentId))
      .returning();
    await writeAudit(tx, actor, {
      eventType: "document.locked_final",
      entityType: "document",
      entityId: documentId,
      taskerId: doc.taskerId,
      payload: {},
    });
    return updated!;
  });
}
