import { and, eq, inArray, isNull } from "drizzle-orm";
import { escalation, gate, tasker } from "../db/schema";
import { systemActor } from "./actor";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";

/**
 * Pending and open gates cannot remain on a CLOSED tasker.
 * A pending gate with no assignee gets the closing human so the status check can pass.
 * The audit actor stays system.
 */
export async function autoCloseOpenGates(
  db: CoreDb,
  taskerId: string,
  fallbackUserId: string,
  reason: "tasker_closed" | "overdue_non_blocking",
  onlyIds?: ReadonlySet<string>,
): Promise<string[]> {
  const open = await db
    .select()
    .from(gate)
    .where(and(eq(gate.taskerId, taskerId), inArray(gate.status, ["pending", "open"])));
  const closed: string[] = [];
  for (const row of open) {
    if (onlyIds && !onlyIds.has(row.id)) continue;
    if (reason === "overdue_non_blocking" && row.blocking) continue;
    await db
      .update(gate)
      .set({
        status: "auto_closed",
        assigneeUserId: row.assigneeUserId ?? fallbackUserId,
        decidedAt: new Date(),
      })
      .where(eq(gate.id, row.id));
    await writeAudit(db, systemActor, {
      eventType: "gate.auto_closed",
      entityType: "gate",
      entityId: row.id,
      taskerId,
      payload: { reason, gate_id: row.id, round: row.round },
    });
    closed.push(row.id);
  }
  return closed;
}

export async function autoCloseOpenEscalations(db: CoreDb, taskerId: string): Promise<void> {
  const open = await db
    .select()
    .from(escalation)
    .where(and(eq(escalation.taskerId, taskerId), isNull(escalation.resolvedAt)));
  for (const row of open) {
    await db
      .update(escalation)
      .set({
        autoClosed: true,
        resolvedAt: new Date(),
        resolution: "Closed with the tasker",
      })
      .where(eq(escalation.id, row.id));
    await writeAudit(db, systemActor, {
      eventType: "escalation.auto_closed",
      entityType: "escalation",
      entityId: row.id,
      taskerId,
      payload: { escalation_id: row.id },
    });
  }
}

export async function closingUserId(db: CoreDb, actor: Actor, taskerId: string): Promise<string> {
  if (actor.type === "user") return actor.userId;
  const [row] = await db.select({ originatorId: tasker.originatorId }).from(tasker).where(eq(tasker.id, taskerId)).limit(1);
  if (!row) throw new Error("tasker missing during close");
  return row.originatorId;
}
