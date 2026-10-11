import { and, eq, inArray } from "drizzle-orm";
import { businessToday, signDisposition } from "../config/missionflow.config";
import { document, documentVersion, gate, taskerAssignment } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import { autoCloseOpenGates } from "./closeout";
import type { CoreDb } from "./db";
import { Forbidden, InvalidTransition, NotFound, ValidationError } from "./errors";
import { authorized } from "./policy";
import { closeTasker, mustTasker, recordDisposition, writeState } from "./tasker-store";
import { isNonTerminal, transitionTo } from "./transitions";

const OPENISH = ["pending", "open"] as const;

async function latestPackageVersion(db: CoreDb, taskerId: string): Promise<string | null> {
  const docs = await db.select().from(document).where(eq(document.taskerId, taskerId));
  let latest: { id: string; at: number } | null = null;
  for (const doc of docs) {
    if (doc.enclave === "final") continue;
    const versions = await db.select().from(documentVersion).where(eq(documentVersion.documentId, doc.id));
    for (const version of versions) {
      const at = version.createdAt.getTime();
      if (!latest || at >= latest.at) latest = { id: version.id, at };
    }
  }
  return latest?.id ?? null;
}

export async function addGate(
  db: CoreDb,
  actor: Actor,
  taskerId: string,
  input: {
    kind: "coordination" | "approval";
    officeLabel: string;
    justification: string;
    dueDate: string;
    assigneeUserId?: string | null;
    positionId?: string | null;
    blocking?: boolean;
    condition?: string | null;
    source?: "registry_mandatory" | "tasking_authority" | "ao_requested";
    sequence?: number;
  },
) {
  if (!input.justification.trim()) throw new ValidationError("A gate needs a justification");
  return authorized(db, actor, "gate.add", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    if (row.state === "CLOSED") throw new InvalidTransition("CLOSED");
    if (input.assigneeUserId) {
      const [assignment] = await tx
        .select()
        .from(taskerAssignment)
        .where(
          and(
            eq(taskerAssignment.taskerId, taskerId),
            eq(taskerAssignment.userId, input.assigneeUserId),
            eq(taskerAssignment.active, true),
          ),
        )
        .limit(1);
      if (assignment?.role === "awareness") throw new ValidationError("Awareness recipients cannot hold a gate");
    }
    const existing = await tx.select({ sequence: gate.sequence }).from(gate).where(eq(gate.taskerId, taskerId));
    const sequence = input.sequence ?? (existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1);
    const status = row.state === "IN_COORDINATION" && input.assigneeUserId ? "open" : "pending";
    const [created] = await tx
      .insert(gate)
      .values({
        taskerId,
        kind: input.kind,
        sequence,
        officeLabel: input.officeLabel,
        positionId: input.positionId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        source: input.source ?? "ao_requested",
        condition: input.condition ?? null,
        justification: input.justification.trim(),
        blocking: input.blocking ?? true,
        dueDate: input.dueDate,
        status,
        packageVersionId: status === "open" ? await latestPackageVersion(tx, taskerId) : null,
      })
      .returning();
    if (!created) throw new Error("gate insert failed");
    await writeAudit(tx, actor, {
      eventType: status === "open" ? "gate.opened" : "gate.created",
      entityType: "gate",
      entityId: created.id,
      taskerId,
      payload: { office: input.officeLabel, kind: input.kind, blocking: created.blocking },
    });
    return created;
  });
}

export async function openGates(db: CoreDb, actor: Actor, taskerId: string) {
  return authorized(db, actor, "gate.open", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    transitionTo(row.state, "open_coordination");
    const pending = await tx
      .select()
      .from(gate)
      .where(and(eq(gate.taskerId, taskerId), eq(gate.kind, "coordination"), eq(gate.status, "pending")));
    if (pending.length === 0) throw new ValidationError("There is no coordination gate to open");
    const packageVersionId = await latestPackageVersion(tx, taskerId);
    for (const item of pending) {
      if (!item.assigneeUserId) throw new ValidationError(`Gate ${item.officeLabel} has no assignee`);
      await tx
        .update(gate)
        .set({ status: "open", packageVersionId: item.packageVersionId ?? packageVersionId })
        .where(eq(gate.id, item.id));
      await writeAudit(tx, actor, {
        eventType: "gate.opened",
        entityType: "gate",
        entityId: item.id,
        taskerId,
        payload: { round: item.round, package_version_id: item.packageVersionId ?? packageVersionId },
      });
    }
    return writeState(tx, actor, row, "IN_COORDINATION");
  });
}

export async function reopenCoordination(db: CoreDb, actor: Actor, taskerId: string, alsoGateIds: string[] = []) {
  return authorized(db, actor, "tasker.reopen_coordination", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    if (row.state !== "IN_WORK") throw new InvalidTransition("reopen coordination from IN_WORK only");
    const gates = await tx.select().from(gate).where(eq(gate.taskerId, taskerId));
    const selected = new Set(alsoGateIds);
    let opened = 0;
    for (const item of gates) {
      const reopen = item.status === "nonconcurred" || (item.status === "concurred" && selected.has(item.id));
      if (!reopen) continue;
      await tx
        .update(gate)
        .set({ status: "open", round: item.round + 1, decisionComment: null, decidedBy: null, decidedAt: null })
        .where(eq(gate.id, item.id));
      await writeAudit(tx, actor, {
        eventType: "gate.reopened",
        entityType: "gate",
        entityId: item.id,
        taskerId,
        payload: { round: item.round + 1 },
      });
      opened += 1;
    }
    if (opened === 0) throw new ValidationError("No nonconcurred gate to reopen");
    return writeState(tx, actor, row, "IN_COORDINATION");
  });
}

async function blockingStillOpen(db: CoreDb, taskerId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(gate)
    .where(and(eq(gate.taskerId, taskerId), eq(gate.kind, "coordination"), eq(gate.blocking, true)));
  return rows.some((row) => row.status !== "concurred" && row.status !== "auto_closed");
}

export async function routeToApproval(db: CoreDb, actor: Actor, taskerId: string) {
  return authorized(db, actor, "tasker.route_approval", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    if (await blockingStillOpen(tx, taskerId)) {
      throw new InvalidTransition("A blocking gate is still open");
    }
    const to = transitionTo(row.state, "route_to_approval");
    return writeState(tx, actor, row, to);
  });
}

export async function elevate(db: CoreDb, actor: Actor, taskerId: string, rationale: string) {
  if (!rationale.trim()) throw new ValidationError("Elevation requires a rationale");
  return authorized(db, actor, "tasker.elevate", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    const openBlocking = await tx
      .select()
      .from(gate)
      .where(and(eq(gate.taskerId, taskerId), eq(gate.blocking, true), eq(gate.status, "open")));
    if (openBlocking.length > 0) throw new InvalidTransition("Elevation is blocked while a blocking gate is open");
    const attached = await tx
      .select()
      .from(gate)
      .where(and(eq(gate.taskerId, taskerId), eq(gate.status, "nonconcurred")));
    if (attached.length === 0) throw new ValidationError("Elevation attaches at least one nonconcurrence");
    const to = transitionTo(row.state, "elevate");
    const payload = {
      gate_ids: attached.map((item) => item.id),
      gate_rounds: attached.map((item) => item.round),
      rationale: rationale.trim(),
    };
    const updated = await writeState(tx, actor, row, to, { elevatedNonconcurrence: payload });
    await writeAudit(tx, actor, {
      eventType: "tasker.elevated_with_nonconcurrence",
      entityType: "tasker",
      entityId: taskerId,
      taskerId,
      payload,
    });
    return updated;
  });
}

export async function decideGate(
  db: CoreDb,
  actor: Actor,
  gateId: string,
  decision: "concur" | "nonconcur" | "endorse" | "approve" | "disapprove" | "sign",
  comment?: string,
) {
  const [peek] = await db.select({ taskerId: gate.taskerId }).from(gate).where(eq(gate.id, gateId)).limit(1);
  if (!peek) throw new NotFound("gate");
  return authorized(db, actor, "gate.decide", { taskerId: peek.taskerId, gateId }, async (tx) => {
    const [item] = await tx.select().from(gate).where(eq(gate.id, gateId)).limit(1);
    if (!item) throw new NotFound("gate");
    if (item.status !== "open") throw new InvalidTransition("The gate is not open");
    if (actor.type !== "user" || item.assigneeUserId !== actor.userId) throw new Forbidden("gate assignee");
    const row = await mustTasker(tx, item.taskerId);
    if (!isNonTerminal(row.state)) throw new InvalidTransition("CLOSED");
    if (item.kind === "coordination" && decision !== "concur" && decision !== "nonconcur") {
      throw new ValidationError("A coordination gate accepts concur or nonconcur");
    }
    if (item.kind === "approval" && (decision === "concur" || decision === "nonconcur")) {
      throw new ValidationError("An approval gate does not take a coordination decision");
    }
    if ((decision === "nonconcur" || decision === "disapprove") && !comment?.trim()) {
      throw new ValidationError("This decision requires a justification");
    }

    if (decision === "disapprove") {
      const to = transitionTo(row.state, "return_for_rework");
      await tx
        .update(gate)
        .set({ status: "disapproved", decisionComment: comment!.trim(), decidedBy: actor.userId, decidedAt: new Date() })
        .where(eq(gate.id, gateId));
      await recordDisposition(tx, actor, {
        taskerId: row.id,
        type: "returned_for_rework",
        fromState: row.state,
        toState: to,
        rationale: comment!.trim(),
        gateId,
        gateRound: item.round,
      });
      await writeAudit(tx, actor, {
        eventType: "gate.decided",
        entityType: "gate",
        entityId: gateId,
        taskerId: row.id,
        payload: { decision, round: item.round },
      });
      return writeState(tx, actor, row, to, { reworkCount: row.reworkCount + 1 });
    }

    if (decision === "sign") {
      if (row.transmitToHigherHq == null) throw new ValidationError("Transmit flag is not set");
      transitionTo(row.state, "sign");
      const type = signDisposition(row.transmitToHigherHq);
      return closeTasker(tx, actor, row, { type, rationale: comment ?? null });
    }

    const status =
      decision === "concur"
        ? "concurred"
        : decision === "nonconcur"
          ? "nonconcurred"
          : decision === "endorse"
            ? "endorsed"
            : "approved";
    await tx
      .update(gate)
      .set({
        status,
        decisionComment: comment?.trim() || null,
        decidedBy: actor.userId,
        decidedAt: new Date(),
      })
      .where(eq(gate.id, gateId));
    await writeAudit(tx, actor, {
      eventType: "gate.decided",
      entityType: "gate",
      entityId: gateId,
      taskerId: row.id,
      payload: { decision, round: item.round },
    });

    if (decision === "concur") {
      await recordDisposition(tx, actor, {
        taskerId: row.id,
        type: "concurred",
        fromState: row.state,
        toState: row.state,
        rationale: comment?.trim() || null,
        gateId,
        gateRound: item.round,
      });
      return row;
    }
    if (decision === "nonconcur") {
      const moved = row.state === "IN_COORDINATION";
      const to = moved ? transitionTo(row.state, "nonconcur_move") : row.state;
      await recordDisposition(tx, actor, {
        taskerId: row.id,
        type: "nonconcurred",
        fromState: row.state,
        toState: to,
        rationale: comment!.trim(),
        gateId,
        gateRound: item.round,
      });
      if (!moved) {
        await writeAudit(tx, actor, {
          eventType: "tasker.nonconcurrence_noted",
          entityType: "gate",
          entityId: gateId,
          taskerId: row.id,
          payload: { gate_id: gateId, notify: ["ao_primary", "approver"], rationale: comment!.trim() },
        });
        return row;
      }
      return writeState(tx, actor, row, to);
    }
    return row;
  });
}

/** Non-blocking gates past their due date close as the system actor. Blocking gates stay open. */
export async function autoCloseOverdue(db: CoreDb, now = new Date()): Promise<string[]> {
  const today = businessToday(now);
  const rows = await db.select().from(gate).where(and(eq(gate.blocking, false), inArray(gate.status, [...OPENISH])));
  const closed: string[] = [];
  const byTasker = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.dueDate >= today) continue;
    const list = byTasker.get(row.taskerId) ?? [];
    list.push(row);
    byTasker.set(row.taskerId, list);
  }
  for (const [taskerId, items] of byTasker) {
    await db.transaction(async (tx) => {
      const handle = tx as unknown as CoreDb;
      const ids = new Set(items.map((item) => item.id));
      const fallback = (await mustTasker(handle, taskerId)).originatorId;
      const all = await autoCloseOpenGates(handle, taskerId, fallback, "overdue_non_blocking", ids);
      for (const id of all) if (ids.has(id)) closed.push(id);
    });
  }
  return closed;
}

export async function disapproveAndRework(db: CoreDb, actor: Actor, taskerId: string, rationale: string) {
  return authorized(db, actor, "tasker.return_rework", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    if (!rationale.trim()) throw new ValidationError("Returned for rework requires a rationale");
    const to = transitionTo(row.state, "return_for_rework");
    await recordDisposition(tx, actor, {
      taskerId,
      type: "returned_for_rework",
      fromState: row.state,
      toState: to,
      rationale: rationale.trim(),
    });
    return writeState(tx, actor, row, to, { reworkCount: row.reworkCount + 1 });
  });
}

