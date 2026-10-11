import { and, asc, eq, inArray } from "drizzle-orm";
import { TASKER_STATES } from "../config/missionflow.config";
import { aiArtifact, appUser, disposition, gate, suspensePlan, taskerAssignment } from "../db/schema";
import { auditForTasker } from "./audit";
import type { Actor } from "./actor";
import type { CoreDb } from "./db";
import { listTaskers, getTasker } from "./lifecycle";

export type VisibleTasker = {
  id: string;
  ref: string;
  title: string;
  state: string;
  externalSuspense: string;
  aoName: string | null;
};

export type TaskerDetail = {
  tasker: {
    id: string;
    ref: string;
    title: string;
    state: string;
    category: string;
    missionFunction: string;
    portfolio: string | null;
    requirement: string;
    contentRedacted: boolean;
    externalSuspense: string;
    priority: string;
    transmitToHigherHq: boolean | null;
    reworkCount: number;
    closedDispositionType: string | null;
  };
  originatorName: string | null;
  aoName: string | null;
  gates: {
    id: string;
    kind: string;
    officeLabel: string;
    status: string;
    round: number;
    dueDate: string;
    blocking: boolean;
    justification: string;
  }[];
  dispositions: {
    id: string;
    type: string;
    fromState: string;
    toState: string;
    actingRole: string;
    rationale: string | null;
    createdAt: Date;
  }[];
  plan: {
    version: number;
    externalSuspense: string;
    latestAoAssignmentDate: string;
    aoWindowPct: string;
    conflict: boolean;
    contingencyBufferDays: number;
  } | null;
  drafts: {
    id: string;
    kind: string;
    provider: string;
    model: string;
    stamp: string;
    content: string;
    withheld: boolean;
    createdAt: Date;
  }[];
  audit: {
    seq: number;
    eventType: string;
    actorType: string;
    actingRole: string | null;
    occurredAt: Date;
  }[];
};

export type VisibleSummary = {
  total: number;
  byState: { state: string; count: number }[];
  conflicts: number;
  triage: number;
};

async function displayName(db: CoreDb, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [user] = await db.select({ displayName: appUser.displayName }).from(appUser).where(eq(appUser.id, userId)).limit(1);
  return user?.displayName ?? null;
}

async function primaryAoName(db: CoreDb, taskerId: string): Promise<string | null> {
  const [assignment] = await db
    .select({ userId: taskerAssignment.userId })
    .from(taskerAssignment)
    .where(and(eq(taskerAssignment.taskerId, taskerId), eq(taskerAssignment.role, "ao_primary"), eq(taskerAssignment.active, true)))
    .limit(1);
  return displayName(db, assignment?.userId ?? null);
}

/** Taskers this acting role may see, with the current action officer's name. */
export async function listVisibleTaskers(db: CoreDb, actor: Actor): Promise<VisibleTasker[]> {
  const rows = await listTaskers(db, actor);
  const visible: VisibleTasker[] = [];
  for (const row of rows) {
    visible.push({
      id: row.id,
      ref: row.ref,
      title: row.title,
      state: row.state,
      externalSuspense: row.externalSuspense,
      aoName: await primaryAoName(db, row.id),
    });
  }
  visible.sort((a, b) => a.ref.localeCompare(b.ref));
  return visible;
}

/** One tasker, plus the related rows a walkthrough needs. Hidden taskers throw NotFound. */
export async function readTaskerDetail(db: CoreDb, actor: Actor, id: string): Promise<TaskerDetail> {
  const row = await getTasker(db, id, actor);
  const redacted = row.contentRedacted;
  const gates = await db.select().from(gate).where(eq(gate.taskerId, id)).orderBy(asc(gate.sequence), asc(gate.round));
  const dispositions = await db.select().from(disposition).where(eq(disposition.taskerId, id)).orderBy(asc(disposition.createdAt));
  const planRow = row.currentSuspensePlanId
    ? await db.select().from(suspensePlan).where(eq(suspensePlan.id, row.currentSuspensePlanId)).limit(1)
    : [];
  const artifacts = await db.select().from(aiArtifact).where(eq(aiArtifact.taskerId, id)).orderBy(asc(aiArtifact.createdAt));
  const trail = await auditForTasker(db, id);
  const aoName = await primaryAoName(db, id);
  const originatorName = await displayName(db, row.originatorId);
  return {
    tasker: {
      id: row.id,
      ref: row.ref,
      title: row.title,
      state: row.state,
      category: row.category,
      missionFunction: row.missionFunction,
      portfolio: row.portfolio,
      requirement: redacted ? "" : row.requirement,
      contentRedacted: redacted,
      externalSuspense: row.externalSuspense,
      priority: row.priority,
      transmitToHigherHq: row.transmitToHigherHq,
      reworkCount: row.reworkCount,
      closedDispositionType: row.closedDispositionType,
    },
    originatorName,
    aoName,
    gates: gates.map((item) => ({
      id: item.id,
      kind: item.kind,
      officeLabel: item.officeLabel,
      status: item.status,
      round: item.round,
      dueDate: item.dueDate,
      blocking: item.blocking,
      justification: item.justification,
    })),
    dispositions: dispositions.map((item) => ({
      id: item.id,
      type: item.type,
      fromState: item.fromState,
      toState: item.toState,
      actingRole: item.actingRole,
      rationale: item.rationale,
      createdAt: item.createdAt,
    })),
    plan: planRow[0]
      ? {
          version: planRow[0].version,
          externalSuspense: planRow[0].externalSuspense,
          latestAoAssignmentDate: planRow[0].latestAoAssignmentDate,
          aoWindowPct: planRow[0].aoWindowPct,
          conflict: planRow[0].conflict,
          contingencyBufferDays: planRow[0].contingencyBufferDays,
        }
      : null,
    drafts: artifacts.map((item) => ({
      id: item.id,
      kind: item.kind,
      provider: item.provider,
      model: item.model,
      stamp: item.stamp,
      content: redacted ? item.stamp : item.content,
      withheld: redacted,
      createdAt: item.createdAt,
    })),
    audit: trail.slice(-40).map((item) => ({
      seq: item.seq,
      eventType: item.eventType,
      actorType: item.actorType,
      actingRole: item.actingRole,
      occurredAt: item.occurredAt,
    })),
  };
}

/** Counts over the taskers this role can see. A conflicted plan counts even when the state is triage. */
export async function summarizeVisible(db: CoreDb, actor: Actor): Promise<VisibleSummary> {
  const rows = await listTaskers(db, actor);
  const counts = new Map<string, number>();
  for (const state of TASKER_STATES) counts.set(state, 0);
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const planIds = rows.map((row) => row.currentSuspensePlanId).filter((id): id is string => Boolean(id));
  const plans = planIds.length
    ? await db
        .select({ id: suspensePlan.id, conflict: suspensePlan.conflict })
        .from(suspensePlan)
        .where(inArray(suspensePlan.id, planIds))
    : [];
  const conflictPlans = new Set(plans.filter((plan) => plan.conflict).map((plan) => plan.id));
  let conflicts = 0;
  for (const row of rows) {
    if (row.state === "SUSPENSE_CONFLICT" || (row.currentSuspensePlanId && conflictPlans.has(row.currentSuspensePlanId))) conflicts += 1;
  }
  return {
    total: rows.length,
    byState: [...counts.entries()].map(([state, count]) => ({ state, count })),
    conflicts,
    triage: counts.get("TRIAGE") ?? 0,
  };
}
