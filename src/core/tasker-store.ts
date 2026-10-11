import { and, eq } from "drizzle-orm";
import type { DispositionType, TaskerState } from "../config/missionflow.config";
import { isClosingDisposition } from "../config/missionflow.config";
import { disposition, document, tasker, taskerAssignment } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import { autoCloseOpenEscalations, autoCloseOpenGates, closingUserId } from "./closeout";
import type { CoreDb } from "./db";
import { Conflict, NotFound, ValidationError } from "./errors";

export type TaskerRow = typeof tasker.$inferSelect;

export async function mustTasker(db: CoreDb, id: string): Promise<TaskerRow> {
  const [row] = await db.select().from(tasker).where(eq(tasker.id, id)).limit(1);
  if (!row) throw new NotFound("tasker");
  return row;
}

export async function saveTasker(
  db: CoreDb,
  row: TaskerRow,
  patch: Partial<typeof tasker.$inferInsert>,
): Promise<TaskerRow> {
  const [updated] = await db
    .update(tasker)
    .set({ ...patch, rowVersion: row.rowVersion + 1, updatedAt: new Date() })
    .where(and(eq(tasker.id, row.id), eq(tasker.rowVersion, row.rowVersion)))
    .returning();
  if (!updated) throw new Conflict("tasker changed; reload and retry");
  return updated;
}

export async function endActiveRole(
  db: CoreDb,
  taskerId: string,
  role: "ao_primary" | "ao_alternate" | "accountable_product_owner",
  reason: string,
): Promise<void> {
  await db
    .update(taskerAssignment)
    .set({ active: false, endedAt: new Date(), endedReason: reason })
    .where(and(eq(taskerAssignment.taskerId, taskerId), eq(taskerAssignment.role, role), eq(taskerAssignment.active, true)));
}

export async function addAssignment(
  db: CoreDb,
  actor: Actor,
  input: {
    taskerId: string;
    userId: string;
    role: typeof taskerAssignment.$inferInsert.role;
    source: typeof taskerAssignment.$inferInsert.source;
    rationale?: string | null;
    positionId?: string | null;
    assignedBy: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(taskerAssignment)
    .values({
      taskerId: input.taskerId,
      userId: input.userId,
      role: input.role,
      source: input.source,
      rationale: input.rationale ?? null,
      positionId: input.positionId ?? null,
      assignedBy: input.assignedBy,
      active: true,
    })
    .returning({ id: taskerAssignment.id });
  if (!row) throw new Error("assignment insert failed");
  await writeAudit(db, actor, {
    eventType: "assignment.created",
    entityType: "tasker_assignment",
    entityId: row.id,
    taskerId: input.taskerId,
    payload: { role: input.role, user_id: input.userId, source: input.source },
  });
  return row.id;
}

export async function recordDisposition(
  db: CoreDb,
  actor: Actor,
  input: {
    taskerId: string;
    type: DispositionType;
    fromState: TaskerState;
    toState: TaskerState;
    rationale?: string | null;
    redirectToUserId?: string | null;
    redirectToEntryId?: string | null;
    gateId?: string | null;
    gateRound?: number | null;
  },
): Promise<string> {
  if (actor.type !== "user") throw new ValidationError("A person applies a disposition");
  const closes = input.toState === "CLOSED";
  if (closes !== isClosingDisposition(input.type)) {
    throw new ValidationError(`${input.type} cannot close a tasker`);
  }
  const [row] = await db
    .insert(disposition)
    .values({
      taskerId: input.taskerId,
      type: input.type,
      appliedBy: actor.userId,
      actingRole: actor.actingRole,
      rationale: input.rationale ?? null,
      redirectToUserId: input.redirectToUserId ?? null,
      redirectToEntryId: input.redirectToEntryId ?? null,
      gateId: input.gateId ?? null,
      gateRound: input.gateRound ?? null,
      fromState: input.fromState,
      toState: input.toState,
      closesTasker: closes,
    })
    .returning({ id: disposition.id });
  if (!row) throw new Error("disposition insert failed");
  await writeAudit(db, actor, {
    eventType: "disposition.applied",
    entityType: "disposition",
    entityId: row.id,
    taskerId: input.taskerId,
    payload: { type: input.type, from: input.fromState, to: input.toState, gate_id: input.gateId ?? null },
  });
  return row.id;
}

export async function closeTasker(
  db: CoreDb,
  actor: Actor,
  row: TaskerRow,
  input: {
    type: DispositionType;
    rationale?: string | null;
    redirectToUserId?: string | null;
    redirectToEntryId?: string | null;
  },
): Promise<TaskerRow> {
  const dispositionId = await recordDisposition(db, actor, {
    taskerId: row.id,
    type: input.type,
    fromState: row.state,
    toState: "CLOSED",
    rationale: input.rationale,
    redirectToUserId: input.redirectToUserId,
    redirectToEntryId: input.redirectToEntryId,
  });
  const fallback = await closingUserId(db, actor, row.id);
  await autoCloseOpenGates(db, row.id, fallback, "tasker_closed");
  await autoCloseOpenEscalations(db, row.id);
  const closedAt = new Date();
  const updated = await saveTasker(db, row, {
    state: "CLOSED",
    closedAt,
    closedDispositionType: input.type,
    finalDispositionId: dispositionId,
  });
  await writeAudit(db, actor, {
    eventType: "tasker.state_changed",
    entityType: "tasker",
    entityId: row.id,
    taskerId: row.id,
    payload: { before: row.state, after: "CLOSED", disposition: input.type },
  });
  await lockFinalDocuments(db, actor, row.id);
  return updated;
}

export async function lockFinalDocuments(db: CoreDb, actor: Actor, taskerId: string): Promise<void> {
  const finals = await db
    .select()
    .from(document)
    .where(and(eq(document.taskerId, taskerId), eq(document.enclave, "final")));
  for (const doc of finals) {
    if (doc.locked) continue;
    await db.update(document).set({ locked: true, checkedOutBy: null, checkedOutAt: null }).where(eq(document.id, doc.id));
    await writeAudit(db, actor, {
      eventType: "document.locked_final",
      entityType: "document",
      entityId: doc.id,
      taskerId,
      payload: { enclave: "final" },
    });
  }
}

export async function writeState(
  db: CoreDb,
  actor: Actor,
  row: TaskerRow,
  to: TaskerState,
  extra: Partial<typeof tasker.$inferInsert> = {},
): Promise<TaskerRow> {
  const updated = await saveTasker(db, row, { ...extra, state: to });
  if (to !== row.state) {
    await writeAudit(db, actor, {
      eventType: "tasker.state_changed",
      entityType: "tasker",
      entityId: row.id,
      taskerId: row.id,
      payload: { before: row.state, after: to },
    });
  }
  return updated;
}
