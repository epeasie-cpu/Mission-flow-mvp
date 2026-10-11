import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  AI_DEMO_LABEL,
  AI_DRAFT_STAMP,
  TEMPLATE_MODEL_ID,
  businessToday,
  enforceAiSpendCaps,
  fallbackToTemplate,
  resolveAiProvider,
  type AiEnv,
  type AiResolution,
} from "../config/missionflow.config";
import { aiArtifact, aiVerification, document, documentVersion } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { NotFound, ValidationError } from "./errors";
import { authorized } from "./policy";
import { businessDayStartUtc } from "./suspense";
import { mustTasker } from "./tasker-store";

export type AiKind = typeof aiArtifact.$inferInsert.kind;

export type GatewayRequest = { model: string; prompt: string; taskerId: string };
export type GatewayClient = (request: GatewayRequest) => Promise<{ model: string; text: string }>;

let gatewayClient: GatewayClient | null = null;

/** Tests inject a mock. The default never calls a network. */
export function setGatewayClientForTests(client: GatewayClient | null): void {
  gatewayClient = client;
}

function stamp(body: string): string {
  return `${AI_DRAFT_STAMP}\n${body.trim()}\n${AI_DRAFT_STAMP}`;
}

function templateBody(title: string, kind: string): string {
  return [
    `Synthetic ${kind.replaceAll("_", " ")} for "${title}".`,
    "This text is a template stand-in. A person verifies it before it is used.",
    "Nominee: a fictional person. Bullets: led a sample project; kept a sample process on time.",
  ].join(" ");
}

async function spendUsage(db: CoreDb, userId: string, now: Date): Promise<{ sessionDraftsThisHour: number; globalDraftsToday: number }> {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const dayStart = businessDayStartUtc(now);
  const [session] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiArtifact)
    .where(and(eq(aiArtifact.requestedBy, userId), gte(aiArtifact.createdAt, hourAgo)));
  const [global] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiArtifact)
    .where(gte(aiArtifact.createdAt, dayStart));
  return { sessionDraftsThisHour: Number(session?.n ?? 0), globalDraftsToday: Number(global?.n ?? 0) };
}

async function callGateway(resolution: Extract<AiResolution, { provider: "vercel_ai_gateway" }>, prompt: string, taskerId: string) {
  const client = gatewayClient;
  if (!client) throw new Error("gateway client is not configured");
  try {
    return await client({ model: resolution.model, prompt, taskerId });
  } catch (primaryError) {
    for (const fallback of resolution.fallbacks) {
      try {
        return await client({ model: fallback, prompt, taskerId });
      } catch {
        continue;
      }
    }
    throw primaryError;
  }
}

export async function generate(
  db: CoreDb,
  actor: Actor,
  taskerId: string,
  kind: AiKind,
  inputRefs: { docVersionId: string; sha256: string }[] = [],
  opts: { env?: AiEnv; now?: Date } = {},
) {
  return authorized(db, actor, "ai.generate", { taskerId }, async (tx) => {
    if (actor.type !== "user") throw new ValidationError("A person requests a draft");
    const row = await mustTasker(tx, taskerId);
    const now = opts.now ?? new Date();
    const env = opts.env ?? (process.env as AiEnv);
    let resolution = resolveAiProvider(env);
    const usage = await spendUsage(tx, actor.userId, now);
    resolution = enforceAiSpendCaps(resolution, usage);
    let notice = resolution.provider === "template" ? resolution.notice : undefined;
    let body = templateBody(row.title, kind);
    let provider: "template" | "vercel_ai_gateway" = "template";
    let model: string = TEMPLATE_MODEL_ID;
    if (resolution.provider === "vercel_ai_gateway") {
      try {
        const answered = await callGateway(resolution, `${kind}\n${row.requirement}`, taskerId);
        body = answered.text;
        provider = "vercel_ai_gateway";
        model = answered.model;
      } catch {
        const fallen = fallbackToTemplate("gateway error", "The commercial drafter failed. The template was used instead.");
        notice = fallen.notice;
        provider = "template";
        model = fallen.model;
      }
    }
    const content = stamp(body);
    const deployment = env.MF_DEPLOYMENT ?? process.env.MF_DEPLOYMENT ?? "local";
    const [artifact] = await tx
      .insert(aiArtifact)
      .values({
        taskerId,
        kind,
        content,
        provider,
        model,
        deployment,
        isAccredited: false,
        demoLabel: provider === "vercel_ai_gateway" ? AI_DEMO_LABEL : null,
        promptTemplateId: "missionflow-template-v1",
        promptVersion: "1",
        inputRefs: inputRefs.map((ref) => ({ doc_version_id: ref.docVersionId, sha256: ref.sha256 })),
        outputSha256: createHash("sha256").update(content).digest("hex"),
        requestedBy: actor.userId,
        createdAt: now,
      })
      .returning();
    await writeAudit(tx, { type: "ai", requestedBy: actor.userId }, {
      eventType: "ai.artifact_generated",
      entityType: "ai_artifact",
      entityId: artifact!.id,
      taskerId,
      aiArtifactId: artifact!.id,
      payload: { requested_by: actor.userId, provider, model, notice: notice ?? null, kind },
    });
    return { artifact: artifact!, notice: notice ?? null };
  });
}

export async function verify(db: CoreDb, actor: Actor, artifactId: string, decision: "verified" | "rejected", note?: string) {
  const [artifact] = await db.select().from(aiArtifact).where(eq(aiArtifact.id, artifactId)).limit(1);
  if (!artifact) throw new NotFound("artifact");
  return authorized(db, actor, "ai.verify", { taskerId: artifact.taskerId }, async (tx) => {
    if (actor.type !== "user") throw new ValidationError("A person verifies a draft");
    const [row] = await tx
      .insert(aiVerification)
      .values({ aiArtifactId: artifactId, decision, note: note ?? null, verifiedBy: actor.userId })
      .returning();
    await writeAudit(tx, actor, {
      eventType: decision === "verified" ? "ai.artifact_verified" : "ai.artifact_rejected",
      entityType: "ai_verification",
      entityId: row!.id,
      taskerId: artifact.taskerId,
      aiArtifactId: artifactId,
      payload: { decision, note: note ?? null },
    });
    return row!;
  });
}

export async function countInputRefs(db: CoreDb, taskerId: string): Promise<{ docVersionId: string; sha256: string }[]> {
  const docs = await db.select().from(document).where(eq(document.taskerId, taskerId));
  const refs: { docVersionId: string; sha256: string }[] = [];
  for (const doc of docs) {
    const versions = await db.select().from(documentVersion).where(eq(documentVersion.documentId, doc.id));
    for (const version of versions) refs.push({ docVersionId: version.id, sha256: version.sha256 });
  }
  return refs;
}

export function businessTodayForAi(now: Date): string {
  return businessToday(now);
}
