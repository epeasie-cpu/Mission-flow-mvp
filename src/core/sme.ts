import { and, eq } from "drizzle-orm";
import { smeInput, taskerAssignment } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { NotFound, ValidationError } from "./errors";
import { authorized } from "./policy";
import { addAssignment, mustTasker } from "./tasker-store";

export async function requestSme(
  db: CoreDb,
  actor: Actor,
  taskerId: string,
  input: { smeUserId: string; ask: string; dueDate?: string | null },
) {
  if (!input.ask.trim()) throw new ValidationError("An SME request needs an ask");
  return authorized(db, actor, "sme.request", { taskerId }, async (tx) => {
    await mustTasker(tx, taskerId);
    if (actor.type !== "user") throw new ValidationError("A person requests SME input");
    const [existing] = await tx
      .select()
      .from(taskerAssignment)
      .where(
        and(
          eq(taskerAssignment.taskerId, taskerId),
          eq(taskerAssignment.userId, input.smeUserId),
          eq(taskerAssignment.role, "sme_contributor"),
          eq(taskerAssignment.active, true),
        ),
      )
      .limit(1);
    if (!existing) {
      await addAssignment(tx, actor, {
        taskerId,
        userId: input.smeUserId,
        role: "sme_contributor",
        source: "manual",
        rationale: input.ask.trim(),
        assignedBy: actor.userId,
      });
    }
    const [row] = await tx
      .insert(smeInput)
      .values({
        taskerId,
        requestedBy: actor.userId,
        smeUserId: input.smeUserId,
        ask: input.ask.trim(),
        dueDate: input.dueDate ?? null,
      })
      .returning();
    await writeAudit(tx, actor, {
      eventType: "sme.requested",
      entityType: "sme_input",
      entityId: row!.id,
      taskerId,
      payload: { sme_user_id: input.smeUserId },
    });
    return row!;
  });
}

export async function submitSme(db: CoreDb, actor: Actor, inputId: string, body: string) {
  if (!body.trim()) throw new ValidationError("SME input needs a response");
  const [peek] = await db.select().from(smeInput).where(eq(smeInput.id, inputId)).limit(1);
  if (!peek) throw new NotFound("sme input");
  return authorized(db, actor, "sme.submit", { taskerId: peek.taskerId }, async (tx) => {
    if (actor.type !== "user" || actor.userId !== peek.smeUserId) throw new ValidationError("Only the requested contributor submits");
    const [updated] = await tx
      .update(smeInput)
      .set({ status: "submitted", response: body.trim(), submittedAt: new Date() })
      .where(eq(smeInput.id, inputId))
      .returning();
    await writeAudit(tx, actor, {
      eventType: "sme.submitted",
      entityType: "sme_input",
      entityId: inputId,
      taskerId: peek.taskerId,
      payload: {},
    });
    return updated!;
  });
}

export async function declineSme(db: CoreDb, actor: Actor, inputId: string, reason: string) {
  if (!reason.trim()) throw new ValidationError("A decline needs a reason");
  const [peek] = await db.select().from(smeInput).where(eq(smeInput.id, inputId)).limit(1);
  if (!peek) throw new NotFound("sme input");
  return authorized(db, actor, "sme.decline", { taskerId: peek.taskerId }, async (tx) => {
    if (actor.type !== "user" || actor.userId !== peek.smeUserId) throw new ValidationError("Only the requested contributor declines");
    const [updated] = await tx
      .update(smeInput)
      .set({ status: "declined", declineReason: reason.trim() })
      .where(eq(smeInput.id, inputId))
      .returning();
    await writeAudit(tx, actor, {
      eventType: "sme.declined",
      entityType: "sme_input",
      entityId: inputId,
      taskerId: peek.taskerId,
      payload: { reason: reason.trim() },
    });
    return updated!;
  });
}
