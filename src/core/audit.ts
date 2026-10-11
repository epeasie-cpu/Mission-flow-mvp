import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { auditEvent, outboxDelivery, outboxEvent } from "../db/schema";
import type { Actor } from "./actor";
import { actorRole } from "./actor";
import type { CoreDb } from "./db";

export type AuditInput = {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  taskerId?: string | null;
  payload?: Record<string, unknown>;
  aiArtifactId?: string | null;
  requestId?: string;
};

export type OutboxRow = typeof outboxEvent.$inferSelect;

type Subscriber = {
  subscriber: string;
  handler: (event: OutboxRow) => Promise<void>;
};

const subscribers = new Map<string, Subscriber[]>();

/** Test hook. Production subscribers register for the life of the process. */
export function clearSubscribers(): void {
  subscribers.clear();
}

export function subscribe(eventType: string, subscriber: string, handler: Subscriber["handler"]): () => void {
  const list = subscribers.get(eventType) ?? [];
  const entry = { subscriber, handler };
  list.push(entry);
  subscribers.set(eventType, list);
  return () => {
    const current = subscribers.get(eventType) ?? [];
    subscribers.set(
      eventType,
      current.filter((item) => item !== entry),
    );
  };
}

export async function writeAudit(db: CoreDb, actor: Actor, input: AuditInput): Promise<{ seq: number; id: string }> {
  const requestId = input.requestId ?? randomUUID();
  const payload = input.payload ?? {};
  const [row] = await db
    .insert(auditEvent)
    .values({
      actorType: actor.type,
      actorUserId: actor.type === "user" ? actor.userId : null,
      actingRole: actorRole(actor),
      eventType: input.eventType,
      taskerId: input.taskerId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      payload,
      aiArtifactId: input.aiArtifactId ?? null,
      requestId,
      prevHash: "",
      hash: "",
    })
    .returning({ seq: auditEvent.seq, id: auditEvent.id });
  if (!row) throw new Error("audit insert returned no row");
  await db.insert(outboxEvent).values({
    auditSeq: row.seq,
    eventType: input.eventType,
    taskerId: input.taskerId ?? null,
    payload,
  });
  return row;
}

/** A denial is committed on its own, so it survives the command transaction rolling back. */
export async function recordAccessDenied(
  db: CoreDb,
  actor: Actor,
  action: string,
  resource?: { taskerId?: string; entryId?: string },
): Promise<void> {
  const subject: Actor = actor.type === "user" ? actor : { type: "system" };
  await writeAudit(db, subject, {
    eventType: "auth.access_denied",
    entityType: resource?.taskerId ? "tasker" : resource?.entryId ? "registry_entry" : "auth",
    entityId: resource?.taskerId ?? resource?.entryId ?? null,
    taskerId: resource?.taskerId ?? null,
    payload: {
      action,
      requested_role: actor.type === "user" ? actor.actingRole : actor.type,
      ...(actor.type === "ai" && actor.requestedBy ? { requested_by: actor.requestedBy } : {}),
    },
  });
}

export async function auditForTasker(db: CoreDb, taskerId: string) {
  return db.select().from(auditEvent).where(eq(auditEvent.taskerId, taskerId)).orderBy(asc(auditEvent.seq));
}

export async function verifyChain(db: CoreDb): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
  const result = await db.execute<{ broken: number | string | null }>(sql`select mf_verify_audit_chain() as broken`);
  const broken = result.rows[0]?.broken;
  if (broken === null || broken === undefined) return { ok: true };
  return { ok: false, brokenAtSeq: Number(broken) };
}

/**
 * Deliver pending outbox rows to in-process subscribers.
 * A subscriber that already has a delivery row is skipped, so a second dispatch is a no-op.
 */
export async function dispatchOutbox(db: CoreDb): Promise<number> {
  const pending = await db
    .select()
    .from(outboxEvent)
    .where(inArray(outboxEvent.status, ["pending", "failed"]))
    .orderBy(asc(outboxEvent.createdAt));
  let delivered = 0;
  for (const event of pending) {
    const hooks = subscribers.get(event.eventType) ?? [];
    if (hooks.length === 0) continue;
    let failed = false;
    for (const hook of hooks) {
      const already = await db
        .select({ id: outboxDelivery.outboxEventId })
        .from(outboxDelivery)
        .where(and(eq(outboxDelivery.outboxEventId, event.id), eq(outboxDelivery.subscriber, hook.subscriber)))
        .limit(1);
      if (already.length > 0) continue;
      try {
        await hook.handler(event);
        await db.insert(outboxDelivery).values({ outboxEventId: event.id, subscriber: hook.subscriber });
      } catch {
        failed = true;
        await db
          .update(outboxEvent)
          .set({ status: "failed", attempts: event.attempts + 1 })
          .where(eq(outboxEvent.id, event.id));
      }
    }
    if (!failed) {
      await db
        .update(outboxEvent)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(outboxEvent.id, event.id));
      delivered += 1;
    }
  }
  return delivered;
}
