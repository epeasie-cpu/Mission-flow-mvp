import { and, eq, isNull, sql } from "drizzle-orm";
import {
  REASSIGNABLE_STATES,
  businessToday,
  defaultTransmitToHigherHq,
  dispositionFieldRules,
  pilot,
  signDisposition,
  type DispositionType,
  type Echelon,
  type TaskCategory,
} from "../config/missionflow.config";
import {
  appUser,
  escalation,
  gate,
  org,
  position,
  suspensePlan,
  suspenseResolution,
  tasker,
  taskerAssignment,
} from "../db/schema";
import type { MatchSnapshot } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { Forbidden, InvalidTransition, NotFound, ValidationError } from "./errors";
import { loadMatchWorld, match } from "./registry";
import { matchTasker } from "./match";
import { authorized, canViewTasker } from "./policy";
import { computeSuspensePlan, insertPlan, loadHolidays } from "./suspense";
import { addAssignment, closeTasker, endActiveRole, mustTasker, recordDisposition, writeState } from "./tasker-store";
import { isNonTerminal, transitionTo } from "./transitions";

const OPTION = {
  a: "a_extension",
  b: "b_descope",
  c: "c_flash_urgent",
  d: "d_augment",
  e: "e_emergency_workflow",
} as const;

export type SuspenseOption = keyof typeof OPTION;

async function nextRef(db: CoreDb, now: Date, requested?: string): Promise<string> {
  if (requested) {
    if (!/^MF-\d{4}-\d{4}$/.test(requested)) throw new ValidationError("Tasker ref must look like MF-2026-0001");
    return requested;
  }
  const year = businessToday(now).slice(0, 4);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(tasker);
  return `MF-${year}-${String(Number(count?.n ?? 0) + 1).padStart(4, "0")}`;
}

function requireUser(actor: Actor): asserts actor is { type: "user"; userId: string; actingRole: string } {
  if (actor.type !== "user") throw new ValidationError("A person performs this command");
}

export async function createDraft(
  db: CoreDb,
  actor: Actor,
  input: {
    title: string;
    category: TaskCategory;
    missionFunction: string;
    portfolio?: string | null;
    targetOrgId: string;
    requirement: string;
    deliverableFormat: string;
    deliverableTemplateId?: string | null;
    deliverableCriteria?: string | null;
    externalSuspense: string;
    priority?: "routine" | "priority" | "flash_urgent";
    ref?: string;
    now?: Date;
  },
) {
  if (!pilot.enabledCategories.includes(input.category)) throw new ValidationError("Category is outside the pilot");
  if (input.priority === "flash_urgent") throw new ValidationError("FLASH/URGENT is only set by corrective option (c)");
  if (!input.title.trim() || !input.requirement.trim() || !input.missionFunction.trim()) {
    throw new ValidationError("Title, mission function, and requirement are required");
  }
  return authorized(db, actor, "tasker.create", {}, async (tx) => {
    requireUser(actor);
    const now = input.now ?? new Date();
    const ref = await nextRef(tx, now, input.ref);
    const [created] = await tx
      .insert(tasker)
      .values({
        ref,
        title: input.title.trim(),
        category: input.category,
        missionFunction: input.missionFunction.trim(),
        portfolio: input.portfolio ?? null,
        targetOrgId: input.targetOrgId,
        requirement: input.requirement.trim(),
        deliverableFormat: input.deliverableFormat,
        deliverableTemplateId: input.deliverableTemplateId ?? null,
        deliverableCriteria: input.deliverableCriteria ?? null,
        externalSuspense: input.externalSuspense,
        priority: input.priority ?? "routine",
        originatorId: actor.userId,
        state: "DRAFT",
      })
      .returning();
    if (!created) throw new Error("tasker insert failed");
    await addAssignment(tx, actor, {
      taskerId: created.id,
      userId: actor.userId,
      role: "originator",
      source: "manual",
      rationale: "Drafted by the originator",
      assignedBy: actor.userId,
    });
    await writeAudit(tx, actor, {
      eventType: "tasker.created",
      entityType: "tasker",
      entityId: created.id,
      taskerId: created.id,
      payload: { ref, category: input.category },
    });
    return created;
  });
}

export async function updateDraft(
  db: CoreDb,
  actor: Actor,
  id: string,
  patch: Partial<{
    title: string;
    missionFunction: string;
    portfolio: string | null;
    requirement: string;
    deliverableFormat: string;
    externalSuspense: string;
    priority: "routine" | "priority" | "flash_urgent";
  }>,
) {
  if (patch.priority === "flash_urgent") throw new ValidationError("FLASH/URGENT is only set by corrective option (c)");
  return authorized(db, actor, "tasker.update_draft", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (row.state !== "DRAFT") throw new InvalidTransition("Draft updates stay in DRAFT");
    const updated = await writeState(tx, actor, row, "DRAFT", patch);
    await writeAudit(tx, actor, {
      eventType: "tasker.draft_updated",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { fields: Object.keys(patch) },
    });
    return updated;
  });
}

export async function submitForRelease(db: CoreDb, actor: Actor, id: string, now = new Date()) {
  return authorized(db, actor, "tasker.submit", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    transitionTo(row.state, "submit_for_release");
    const result = await match(tx, {
      category: row.category,
      missionFunction: row.missionFunction,
      portfolio: row.portfolio,
      targetOrgId: row.targetOrgId,
      title: row.title,
      requirement: row.requirement,
      now,
    });
    const holidays = await loadHolidays(tx);
    const plan = computeSuspensePlan({
      externalSuspense: row.externalSuspense,
      profile: result.profile.map((stage) => ({ stage: stage.stage, business_days: stage.business_days })),
      holidays,
      now,
    });
    requireUser(actor);
    const planId = await insertPlan(tx, { taskerId: id, plan, computedBy: actor.userId });
    const snapshot: MatchSnapshot = {
      candidates: result.candidates.map((candidate) => ({
        entryId: candidate.entryId,
        score: candidate.score,
        reasons: candidate.reasons,
      })),
      ...(result.chosen ? { chosen: result.chosen } : {}),
      confidence: result.confidence,
      resolved: result.resolved as unknown as Record<string, unknown>,
      failoverApplied: result.failoverApplied,
    };
    let state: typeof row.state = "PENDING_RELEASE";
    if (result.route === "triage") state = "TRIAGE";
    else if (plan.conflict) state = "SUSPENSE_CONFLICT";
    const updated = await writeState(tx, actor, row, state, {
      matchSnapshot: snapshot,
      currentSuspensePlanId: planId,
      submittedForReleaseAt: now,
      ...(state === "TRIAGE" ? { triageEnteredAt: now } : {}),
    });
    await writeAudit(tx, actor, {
      eventType: "tasker.match_proposed",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { confidence: result.confidence, chosen: result.chosen ?? null, route: result.route },
    });
    await writeAudit(tx, actor, {
      eventType: "suspense.plan_computed",
      entityType: "suspense_plan",
      entityId: planId,
      taskerId: id,
      payload: {
        latest_ao_assignment_date: plan.latestAoAssignmentDate,
        ao_window_pct: plan.aoWindowPct,
        warning: plan.warning,
        conflict: plan.conflict,
      },
    });
    if (state === "SUSPENSE_CONFLICT") {
      await writeAudit(tx, actor, {
        eventType: "suspense.conflict_flagged",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { latest_ao_assignment_date: plan.latestAoAssignmentDate },
      });
    }
    if (state === "TRIAGE") {
      await writeAudit(tx, actor, {
        eventType: "triage.entered",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { reason: result.triageReason ?? "no_match", phase: "pre_release" },
      });
    }
    return { tasker: updated, match: result, plan };
  });
}

export async function resolveSuspenseConflict(
  db: CoreDb,
  actor: Actor,
  id: string,
  option: SuspenseOption,
  rationale: string,
  now = new Date(),
) {
  if (!rationale.trim()) throw new ValidationError("A corrective option requires a rationale");
  return authorized(db, actor, "tasker.resolve_suspense", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (row.state !== "SUSPENSE_CONFLICT" || !row.currentSuspensePlanId) {
      throw new InvalidTransition("resolve suspense from SUSPENSE_CONFLICT");
    }
    requireUser(actor);
    if (option === "a") {
      await tx.insert(suspenseResolution).values({
        taskerId: id,
        conflictedPlanId: row.currentSuspensePlanId,
        resultingPlanId: null,
        option: OPTION.a,
        rationale: rationale.trim(),
        resolvedBy: actor.userId,
      });
      await writeAudit(tx, actor, {
        eventType: "suspense.conflict_resolved",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { option: "a", stays_blocked: true },
      });
      return row;
    }
    const [previous] = await tx.select().from(suspensePlan).where(eq(suspensePlan.id, row.currentSuspensePlanId)).limit(1);
    if (!previous) throw new NotFound("suspense plan");
    const holidays = await loadHolidays(tx);
    const recomputed = computeSuspensePlan({
      externalSuspense: previous.externalSuspense,
      profile: previous.stages
        .filter((stage) => stage.name !== "contingency_buffer")
        .map((stage) => ({ stage: stage.name, business_days: stage.business_days })),
      bufferDays: previous.contingencyBufferDays,
      holidays,
      now,
    });
    const planId = await insertPlan(tx, {
      taskerId: id,
      plan: { ...recomputed, conflict: false },
      computedBy: actor.userId,
      conflict: false,
    });
    await tx.insert(suspenseResolution).values({
      taskerId: id,
      conflictedPlanId: row.currentSuspensePlanId,
      resultingPlanId: planId,
      option: OPTION[option],
      rationale: rationale.trim(),
      resolvedBy: actor.userId,
    });
    const extra = option === "c" ? { priority: "flash_urgent" as const, currentSuspensePlanId: planId } : { currentSuspensePlanId: planId };
    const updated = await writeState(tx, actor, row, "PENDING_RELEASE", extra);
    if (option === "c") {
      await writeAudit(tx, actor, {
        eventType: "tasker.priority_changed",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { priority: "flash_urgent", option: "c" },
      });
    }
    await writeAudit(tx, actor, {
      eventType: "suspense.conflict_resolved",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { option, resulting_plan_id: planId },
    });
    return updated;
  });
}

export async function setExternalSuspense(db: CoreDb, actor: Actor, id: string, externalSuspense: string, now = new Date()) {
  return authorized(db, actor, "tasker.change_suspense", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (row.releasedAt) throw new InvalidTransition("Use the post-release suspense command after dispatch");
    if (row.state !== "SUSPENSE_CONFLICT" && row.state !== "PENDING_RELEASE") {
      throw new InvalidTransition("External suspense can be replaced before release");
    }
    requireUser(actor);
    const holidays = await loadHolidays(tx);
    const world = await loadMatchWorld(tx, now);
    const matched = matchTasker(
      {
        category: row.category,
        missionFunction: row.missionFunction,
        portfolio: row.portfolio,
        targetOrgId: row.targetOrgId,
        title: row.title,
        requirement: row.requirement,
        now,
      },
      world,
    );
    const plan = computeSuspensePlan({
      externalSuspense,
      profile: matched.profile.map((stage) => ({ stage: stage.stage, business_days: stage.business_days })),
      holidays,
      now,
    });
    const planId = await insertPlan(tx, { taskerId: id, plan, computedBy: actor.userId });
    const state = plan.conflict ? "SUSPENSE_CONFLICT" : "PENDING_RELEASE";
    const updated = await writeState(tx, actor, row, state, { externalSuspense, currentSuspensePlanId: planId });
    await writeAudit(tx, actor, {
      eventType: "suspense.plan_computed",
      entityType: "suspense_plan",
      entityId: planId,
      taskerId: id,
      payload: { external_suspense: externalSuspense, conflict: plan.conflict },
    });
    return updated;
  });
}

export async function changeSuspenseAfterRelease(
  db: CoreDb,
  actor: Actor,
  id: string,
  externalSuspense: string,
  now = new Date(),
) {
  return authorized(db, actor, "tasker.change_suspense", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (!row.releasedAt || row.state === "CLOSED") throw new InvalidTransition("Post-release suspense change");
    requireUser(actor);
    const holidays = await loadHolidays(tx);
    const [previous] = row.currentSuspensePlanId
      ? await tx.select().from(suspensePlan).where(eq(suspensePlan.id, row.currentSuspensePlanId)).limit(1)
      : [];
    const plan = computeSuspensePlan({
      externalSuspense,
      profile: previous
        ? previous.stages
            .filter((stage) => stage.name !== "contingency_buffer")
            .map((stage) => ({ stage: stage.name, business_days: stage.business_days }))
        : undefined,
      bufferDays: previous?.contingencyBufferDays,
      holidays,
      now,
    });
    const planId = await insertPlan(tx, { taskerId: id, plan, computedBy: actor.userId, conflict: false });
    const updated = await writeState(tx, actor, row, row.state, { externalSuspense, currentSuspensePlanId: planId });
    await writeAudit(tx, actor, {
      eventType: "suspense.suspense_changed_post_release",
      entityType: "suspense_plan",
      entityId: planId,
      taskerId: id,
      payload: { external_suspense: externalSuspense },
    });
    return updated;
  });
}

export async function release(
  db: CoreDb,
  actor: Actor,
  id: string,
  input: { confirmedEntryId?: string; confirmedPlanId?: string; transmitToHigherHq?: boolean; includeConditional?: boolean; now?: Date } = {},
) {
  return authorized(db, actor, "tasker.release", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    transitionTo(row.state, "release");
    const snapshot = row.matchSnapshot;
    if (!snapshot?.chosen || snapshot.confidence !== "clear") throw new ValidationError("Release needs a clear match");
    if (input.confirmedEntryId && input.confirmedEntryId !== snapshot.chosen) {
      throw new ValidationError("Confirmed entry does not match the proposal");
    }
    if (input.confirmedPlanId && input.confirmedPlanId !== row.currentSuspensePlanId) {
      throw new ValidationError("Confirmed plan does not match the current plan");
    }
    if (!row.currentSuspensePlanId) throw new ValidationError("Release needs a suspense plan");
    const [plan] = await tx.select().from(suspensePlan).where(eq(suspensePlan.id, row.currentSuspensePlanId)).limit(1);
    if (!plan || plan.conflict) throw new InvalidTransition("A conflicted plan cannot be released");
    requireUser(actor);
    const resolved = snapshot.resolved as {
      aoPrimary?: { userId: string; source: "registry_match" | "alternate_failover" };
      aoAlternate?: { userId: string };
      apo?: { userId: string };
      approver?: { userId: string };
      coordinators?: { userId: string; office: string; positionId: string; condition?: string; justification: string }[];
      awareness?: { userId: string }[];
    };
    if (!resolved.aoPrimary || !resolved.aoAlternate || !resolved.apo || !resolved.approver) {
      throw new ValidationError("Release needs an AO, alternate, owner, and approver");
    }
    const activeRoles = new Set(
      (await tx.select({ role: taskerAssignment.role }).from(taskerAssignment).where(and(eq(taskerAssignment.taskerId, id), eq(taskerAssignment.active, true)))).map(
        (item) => item.role,
      ),
    );
    const approverPosition = await approverOrg(tx, resolved.approver.userId);
    const originator = await userOrg(tx, row.originatorId);
    const transmit = input.transmitToHigherHq ?? defaultTransmitToHigherHq(originator, approverPosition);
    const now = input.now ?? new Date();
    if (!activeRoles.has("ao_primary")) {
      await addAssignment(tx, actor, {
        taskerId: id,
        userId: resolved.aoPrimary.userId,
        role: "ao_primary",
        source: resolved.aoPrimary.source,
        assignedBy: actor.userId,
        ...(resolved.aoPrimary.source === "alternate_failover" ? { rationale: "Primary AO unavailable" } : {}),
      });
    }
    if (resolved.aoPrimary.source === "alternate_failover") {
      await writeAudit(tx, actor, {
        eventType: "assignment.alternate_failover",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { user_id: resolved.aoPrimary.userId },
      });
    }
    if (!activeRoles.has("ao_alternate")) {
      await addAssignment(tx, actor, {
        taskerId: id,
        userId: resolved.aoAlternate.userId,
        role: "ao_alternate",
        source: "registry_match",
        assignedBy: actor.userId,
      });
    }
    if (!activeRoles.has("accountable_product_owner")) {
      await addAssignment(tx, actor, {
        taskerId: id,
        userId: resolved.apo.userId,
        role: "accountable_product_owner",
        source: "registry_match",
        assignedBy: actor.userId,
      });
    }
    if (!activeRoles.has("approver")) {
      await addAssignment(tx, actor, {
        taskerId: id,
        userId: resolved.approver.userId,
        role: "approver",
        source: "registry_match",
        assignedBy: actor.userId,
      });
    }
    let sequence = 1;
    for (const coordinator of resolved.coordinators ?? []) {
      if (coordinator.condition && !input.includeConditional) continue;
      await addAssignment(tx, actor, {
        taskerId: id,
        userId: coordinator.userId,
        role: "coordinator",
        source: "registry_match",
        positionId: coordinator.positionId,
        assignedBy: actor.userId,
      });
      const [created] = await tx
        .insert(gate)
        .values({
          taskerId: id,
          kind: "coordination",
          sequence,
          officeLabel: coordinator.office,
          positionId: coordinator.positionId,
          assigneeUserId: coordinator.userId,
          source: "registry_mandatory",
          condition: coordinator.condition ?? null,
          justification: coordinator.justification,
          blocking: true,
          dueDate: row.externalSuspense,
          status: "pending",
        })
        .returning({ id: gate.id });
      await writeAudit(tx, actor, {
        eventType: "gate.created",
        entityType: "gate",
        entityId: created!.id,
        taskerId: id,
        payload: { office: coordinator.office },
      });
      sequence += 1;
    }
    const [approval] = await tx
      .insert(gate)
      .values({
        taskerId: id,
        kind: "approval",
        sequence: sequence + 1,
        officeLabel: "Approver",
        assigneeUserId: resolved.approver.userId,
        source: "registry_mandatory",
        justification: "Approval gate for the designated approver",
        blocking: true,
        dueDate: row.externalSuspense,
        status: "pending",
      })
      .returning({ id: gate.id });
    await writeAudit(tx, actor, {
      eventType: "gate.created",
      entityType: "gate",
      entityId: approval!.id,
      taskerId: id,
      payload: { kind: "approval" },
    });
    for (const person of resolved.awareness ?? []) {
      if (person.userId === resolved.aoPrimary.userId) continue;
      await addAssignment(tx, actor, {
        taskerId: id,
        userId: person.userId,
        role: "awareness",
        source: "registry_match",
        assignedBy: actor.userId,
      });
    }
    const updated = await writeState(tx, actor, row, "ASSIGNED", {
      registryEntryId: snapshot.chosen,
      taskingAuthorityId: actor.userId,
      transmitToHigherHq: transmit,
      releasedAt: now,
      currentSuspensePlanId: row.currentSuspensePlanId,
    });
    await writeAudit(tx, actor, {
      eventType: "tasker.match_confirmed",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { entry_id: snapshot.chosen },
    });
    await writeAudit(tx, actor, {
      eventType: "tasker.released",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { transmit_to_higher_hq: transmit },
    });
    return updated;
  });
}

async function userOrg(db: CoreDb, userId: string): Promise<Echelon> {
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user) throw new NotFound("user");
  const [unit] = await db.select().from(org).where(eq(org.id, user.orgId)).limit(1);
  if (!unit) throw new NotFound("org");
  return unit.echelon;
}

async function approverOrg(db: CoreDb, userId: string): Promise<Echelon> {
  const [seat] = await db.select().from(position).where(eq(position.incumbentUserId, userId)).limit(1);
  if (!seat) return userOrg(db, userId);
  const [unit] = await db.select().from(org).where(eq(org.id, seat.orgId)).limit(1);
  if (!unit) return userOrg(db, userId);
  return unit.echelon;
}

export async function changeTransmitFlag(db: CoreDb, actor: Actor, id: string, transmitToHigherHq: boolean) {
  return authorized(db, actor, "tasker.change_transmit", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (!row.releasedAt || row.state === "CLOSED") throw new InvalidTransition("Transmit flag changes after release and before close");
    const updated = await writeState(tx, actor, row, row.state, { transmitToHigherHq });
    await writeAudit(tx, actor, {
      eventType: "tasker.transmit_flag_changed",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { before: row.transmitToHigherHq, after: transmitToHigherHq },
    });
    return updated;
  });
}

export async function acknowledge(db: CoreDb, actor: Actor, id: string) {
  return authorized(db, actor, "tasker.acknowledge", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (row.state === "CLOSED" || row.state === "DRAFT") throw new InvalidTransition("acknowledge");
    await writeAudit(tx, actor, {
      eventType: "tasker.acknowledged",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: {},
    });
    return row;
  });
}

export async function accept(db: CoreDb, actor: Actor, id: string, now = new Date()) {
  return authorized(db, actor, "tasker.accept", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    const to = transitionTo(row.state, "accept");
    requireUser(actor);
    const [assignment] = await tx
      .select()
      .from(taskerAssignment)
      .where(
        and(
          eq(taskerAssignment.taskerId, id),
          eq(taskerAssignment.userId, actor.userId),
          eq(taskerAssignment.role, "ao_primary"),
          eq(taskerAssignment.active, true),
        ),
      )
      .limit(1);
    if (!assignment) throw new ValidationError("The current action officer accepts");
    if (!assignment.acceptedAt) {
      await tx.update(taskerAssignment).set({ acceptedAt: now }).where(eq(taskerAssignment.id, assignment.id));
    }
    const updated = await writeState(tx, actor, row, to, { acceptedAt: now });
    await writeAudit(tx, actor, {
      eventType: "tasker.accepted",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { accepted_at: now.toISOString() },
    });
    return updated;
  });
}

export async function requestClarification(db: CoreDb, actor: Actor, id: string, question: string) {
  if (!question.trim()) throw new ValidationError("A clarification needs a question");
  return authorized(db, actor, "tasker.clarify", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    const to = transitionTo(row.state, "request_clarification");
    const { clarification } = await import("../db/schema");
    requireUser(actor);
    const [asked] = await tx
      .insert(clarification)
      .values({ taskerId: id, askedBy: actor.userId, question: question.trim() })
      .returning({ id: clarification.id });
    const updated = await writeState(tx, actor, row, to);
    await writeAudit(tx, actor, {
      eventType: "tasker.clarification_requested",
      entityType: "clarification",
      entityId: asked!.id,
      taskerId: id,
      payload: { question: question.trim() },
    });
    return updated;
  });
}

export async function answerClarification(db: CoreDb, actor: Actor, id: string, answer: string, now = new Date()) {
  if (!answer.trim()) throw new ValidationError("An answer is required");
  return authorized(db, actor, "tasker.answer_clarification", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    const to = transitionTo(row.state, "answer_clarification");
    const { clarification } = await import("../db/schema");
    requireUser(actor);
    const [open] = await tx
      .select()
      .from(clarification)
      .where(and(eq(clarification.taskerId, id), isNull(clarification.answeredAt)))
      .limit(1);
    if (!open) throw new ValidationError("There is no open clarification");
    await tx
      .update(clarification)
      .set({ answer: answer.trim(), answeredBy: actor.userId, answeredAt: now })
      .where(eq(clarification.id, open.id));
    const updated = await writeState(tx, actor, row, to);
    await writeAudit(tx, actor, {
      eventType: "tasker.clarification_answered",
      entityType: "clarification",
      entityId: open.id,
      taskerId: id,
      payload: {},
    });
    return updated;
  });
}

export async function claimNoEquity(db: CoreDb, actor: Actor, id: string, rationale: string, now = new Date()) {
  if (!rationale.trim()) throw new ValidationError("No-equity claim requires a rationale");
  return authorized(db, actor, "tasker.claim_no_equity", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (!row.releasedAt) throw new InvalidTransition("No-equity after dispatch uses the action officer claim");
    const to = transitionTo(row.state, "claim_no_equity");
    const updated = await writeState(tx, actor, row, to, { triageEnteredAt: now });
    await writeAudit(tx, actor, {
      eventType: "triage.entered",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { reason: rationale.trim(), phase: "post_dispatch" },
    });
    return updated;
  });
}

export async function adjudicateTriage(
  db: CoreDb,
  actor: Actor,
  id: string,
  outcome: "entry_picked" | "reassigned" | "no_equity" | "equity_confirmed",
  input: { rationale?: string; entryId?: string; userId?: string; now?: Date },
) {
  return authorized(db, actor, outcome === "reassigned" ? "tasker.reassign" : outcome === "no_equity" ? "tasker.no_equity" : "tasker.adjudicate", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (row.state !== "TRIAGE") throw new InvalidTransition("adjudicate from TRIAGE");
    requireUser(actor);
    if (!row.releasedAt) {
      if (outcome !== "entry_picked") throw new InvalidTransition("Pre-release triage is an entry or person pick, not a disposition");
      if (!input.entryId && !input.userId) throw new ValidationError("Pick an entry or a person");
      const snapshot: MatchSnapshot = {
        ...(row.matchSnapshot ?? { candidates: [], confidence: "none" as const, resolved: {}, failoverApplied: false }),
        ...(input.entryId ? { chosen: input.entryId, confidence: "clear" as const } : {}),
      };
      const updated = await writeState(tx, actor, row, "PENDING_RELEASE", {
        matchSnapshot: snapshot,
        ...(input.entryId ? { registryEntryId: input.entryId } : {}),
      });
      if (input.userId) {
        const [existing] = await tx
          .select()
          .from(taskerAssignment)
          .where(and(eq(taskerAssignment.taskerId, id), eq(taskerAssignment.role, "ao_primary"), eq(taskerAssignment.active, true)))
          .limit(1);
        if (existing) await endActiveRole(tx, id, "ao_primary", "triage pick");
        await addAssignment(tx, actor, {
          taskerId: id,
          userId: input.userId,
          role: "ao_primary",
          source: "manual",
          rationale: input.rationale?.trim() || "Functional owner picked the action officer",
          assignedBy: actor.userId,
        });
      }
      await writeAudit(tx, actor, {
        eventType: "triage.adjudicated",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { outcome: "entry_picked", entry_id: input.entryId ?? null, user_id: input.userId ?? null },
      });
      return updated;
    }
    if (!input.rationale?.trim()) throw new ValidationError("Post-dispatch adjudication requires a rationale");
    if (outcome === "equity_confirmed") {
      const updated = await writeState(tx, actor, row, "ASSIGNED");
      await writeAudit(tx, actor, {
        eventType: "triage.adjudicated",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { outcome: "equity_confirmed", rationale: input.rationale.trim() },
      });
      return updated;
    }
    if (outcome === "no_equity") {
      const updated = await closeTasker(tx, actor, row, {
        type: "no_equity_validated",
        rationale: input.rationale.trim(),
        redirectToUserId: input.userId ?? null,
        redirectToEntryId: input.entryId ?? null,
      });
      await writeAudit(tx, actor, {
        eventType: "triage.adjudicated",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { outcome: "no_equity" },
      });
      return updated;
    }
    if (outcome === "reassigned") {
      if (!input.userId) throw new ValidationError("Reassignment needs a person");
      const updated = await reassignInside(tx, actor, row, input.userId, input.rationale.trim());
      await writeAudit(tx, actor, {
        eventType: "triage.adjudicated",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: { outcome: "reassigned", user_id: input.userId },
      });
      return updated;
    }
    throw new ValidationError("Unknown triage outcome");
  });
}

async function reassignInside(tx: CoreDb, actor: Actor & { type: "user" }, row: Awaited<ReturnType<typeof mustTasker>>, userId: string, rationale: string) {
  if (!REASSIGNABLE_STATES.includes(row.state)) throw new InvalidTransition(`reassign from ${row.state}`);
  if (row.state === "TRIAGE" && !row.releasedAt) throw new InvalidTransition("Pre-release triage is not a reassignment");
  transitionTo(row.state, "reassign");
  await endActiveRole(tx, row.id, "ao_primary", "reassigned");
  await addAssignment(tx, actor, {
    taskerId: row.id,
    userId,
    role: "ao_primary",
    source: "reassignment",
    rationale,
    assignedBy: actor.userId,
  });
  await recordDisposition(tx, actor, {
    taskerId: row.id,
    type: "reassigned",
    fromState: row.state,
    toState: "ASSIGNED",
    rationale,
    redirectToUserId: userId,
  });
  const updated = await writeState(tx, actor, row, "ASSIGNED", { acceptedAt: null });
  await writeAudit(tx, actor, {
    eventType: "assignment.ended",
    entityType: "tasker",
    entityId: row.id,
    taskerId: row.id,
    payload: { redirect_to: userId },
  });
  return updated;
}

export async function reassign(db: CoreDb, actor: Actor, id: string, userId: string, rationale: string) {
  if (!rationale.trim() || !userId) throw new ValidationError("Reassignment needs a rationale and a person");
  return authorized(db, actor, "tasker.reassign", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    requireUser(actor);
    return reassignInside(tx, actor, row, userId, rationale.trim());
  });
}

export async function applyDisposition(
  db: CoreDb,
  actor: Actor,
  id: string,
  type: DispositionType,
  opts: { rationale?: string; redirectTo?: string; redirectToEntryId?: string; gateId?: string } = {},
) {
  const rules = dispositionFieldRules[type];
  if (rules.rationale === "required" && !opts.rationale?.trim()) throw new ValidationError(`${type} requires a rationale`);
  if (rules.redirect === "required" && !opts.redirectTo && !opts.redirectToEntryId) {
    throw new ValidationError(`${type} requires a redirection`);
  }
  const action =
    type === "concurred" || type === "nonconcurred"
      ? `tasker.disposition.${type}`
      : type === "reassigned"
        ? "tasker.reassign"
        : type === "cancelled_obe"
          ? "tasker.cancel"
          : type === "returned_for_rework"
            ? "tasker.return_rework"
            : type === "no_equity_validated"
              ? "tasker.no_equity"
              : "tasker.sign";
  return authorized(db, actor, action, { taskerId: id, ...(opts.gateId ? { gateId: opts.gateId } : {}) }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (!isNonTerminal(row.state)) throw new InvalidTransition("CLOSED");
    requireUser(actor);
    if (type === "completed" || type === "submitted") {
      if (row.transmitToHigherHq == null) throw new ValidationError("Transmit flag is not set");
      const expected = signDisposition(row.transmitToHigherHq);
      if (type !== expected) throw new ValidationError("The approver cannot pick Completed versus Submitted");
      transitionTo(row.state, "sign");
      return closeTasker(tx, actor, row, { type, rationale: opts.rationale ?? null });
    }
    if (type === "cancelled_obe") {
      transitionTo(row.state, "cancel");
      return closeTasker(tx, actor, row, { type, rationale: opts.rationale ?? null });
    }
    if (type === "no_equity_validated") {
      if (row.state !== "TRIAGE") throw new InvalidTransition("no_equity_validated");
      return closeTasker(tx, actor, row, {
        type,
        rationale: opts.rationale ?? null,
        redirectToUserId: opts.redirectTo ?? null,
        redirectToEntryId: opts.redirectToEntryId ?? null,
      });
    }
    if (type === "reassigned") {
      if (!opts.redirectTo) throw new ValidationError("Reassignment needs a person");
      return reassignInside(tx, actor, row, opts.redirectTo, opts.rationale!.trim());
    }
    if (type === "returned_for_rework") {
      const to = transitionTo(row.state, "return_for_rework");
      await recordDisposition(tx, actor, {
        taskerId: id,
        type,
        fromState: row.state,
        toState: to,
        rationale: opts.rationale!.trim(),
      });
      return writeState(tx, actor, row, to, { reworkCount: row.reworkCount + 1 });
    }
    if (!opts.gateId) throw new ValidationError("A gate decision names its gate");
    const [item] = await tx.select().from(gate).where(eq(gate.id, opts.gateId)).limit(1);
    if (!item || item.taskerId !== id) throw new NotFound("gate");
    if (item.status !== "open") throw new InvalidTransition("The gate is not open");
    if (item.assigneeUserId !== actor.userId) throw new Forbidden("Only the gate assignee decides it");
    if (type === "concurred") {
      await tx
        .update(gate)
        .set({ status: "concurred", decisionComment: opts.rationale?.trim() || null, decidedBy: actor.userId, decidedAt: new Date() })
        .where(eq(gate.id, item.id));
      await recordDisposition(tx, actor, {
        taskerId: id,
        type,
        fromState: row.state,
        toState: row.state,
        rationale: opts.rationale ?? null,
        gateId: item.id,
        gateRound: item.round,
      });
      await writeAudit(tx, actor, {
        eventType: "gate.decided",
        entityType: "gate",
        entityId: item.id,
        taskerId: id,
        payload: { decision: "concur" },
      });
      return row;
    }
    const moved = row.state === "IN_COORDINATION";
    const to = moved ? transitionTo(row.state, "nonconcur_move") : row.state;
    await tx
      .update(gate)
      .set({ status: "nonconcurred", decisionComment: opts.rationale!.trim(), decidedBy: actor.userId, decidedAt: new Date() })
      .where(eq(gate.id, item.id));
    await recordDisposition(tx, actor, {
      taskerId: id,
      type,
      fromState: row.state,
      toState: to,
      rationale: opts.rationale!.trim(),
      gateId: item.id,
      gateRound: item.round,
    });
    await writeAudit(tx, actor, {
      eventType: "gate.decided",
      entityType: "gate",
      entityId: item.id,
      taskerId: id,
      payload: { decision: "nonconcur" },
    });
    if (!moved) {
      await writeAudit(tx, actor, {
        eventType: "tasker.nonconcurrence_noted",
        entityType: "gate",
        entityId: item.id,
        taskerId: id,
        payload: { gate_id: item.id, notify: ["ao_primary", "approver"] },
      });
      return row;
    }
    return writeState(tx, actor, row, to);
  });
}

export async function sign(db: CoreDb, actor: Actor, id: string, comment?: string) {
  return authorized(db, actor, "tasker.sign", { taskerId: id }, async (tx) => {
    const row = await mustTasker(tx, id);
    if (row.transmitToHigherHq == null) throw new ValidationError("Transmit flag is not set");
    transitionTo(row.state, "sign");
    const type = signDisposition(row.transmitToHigherHq);
    return closeTasker(tx, actor, row, { type, rationale: comment ?? null });
  });
}

export async function cancel(db: CoreDb, actor: Actor, id: string, rationale: string) {
  return applyDisposition(db, actor, id, "cancelled_obe", { rationale });
}

export function timeToCorrectAo(row: { acceptedAt: Date | null; submittedForReleaseAt: Date | null }): number | null {
  if (!row.acceptedAt || !row.submittedForReleaseAt) return null;
  return row.acceptedAt.getTime() - row.submittedForReleaseAt.getTime();
}

export async function getTasker(db: CoreDb, id: string, viewer: Actor) {
  const [row] = await db.select().from(tasker).where(eq(tasker.id, id)).limit(1);
  if (!row) throw new NotFound("tasker");
  const access = await canViewTasker(db, viewer, id);
  if (access === "none") {
    await writeAudit(db, viewer.type === "user" ? viewer : { type: "system" }, {
      eventType: "auth.access_denied",
      entityType: "tasker",
      entityId: id,
      taskerId: id,
      payload: { action: "tasker.view" },
    });
    throw new NotFound("tasker");
  }
  if (access === "full" && viewer.type === "user" && viewer.actingRole === "ao_primary" && !row.firstViewedByAoAt) {
    const [assignment] = await db
      .select()
      .from(taskerAssignment)
      .where(
        and(
          eq(taskerAssignment.taskerId, id),
          eq(taskerAssignment.userId, viewer.userId),
          eq(taskerAssignment.role, "ao_primary"),
          eq(taskerAssignment.active, true),
        ),
      )
      .limit(1);
    if (assignment) {
      const seenAt = new Date();
      await db.update(tasker).set({ firstViewedByAoAt: seenAt }).where(eq(tasker.id, id));
      await writeAudit(db, viewer, {
        eventType: "tasker.first_viewed_by_ao",
        entityType: "tasker",
        entityId: id,
        taskerId: id,
        payload: {},
      });
      row.firstViewedByAoAt = seenAt;
    }
  }
  if (access === "metadata") {
    return { ...row, requirement: "", deliverableCriteria: null, contentRedacted: true as const };
  }
  return { ...row, contentRedacted: false as const };
}

export async function listTaskers(db: CoreDb, viewer: Actor, filter: { state?: string } = {}) {
  const rows = await db.select().from(tasker);
  const visible = [];
  for (const row of rows) {
    if (filter.state && row.state !== filter.state) continue;
    const access = await canViewTasker(db, viewer, row.id);
    if (access === "none") continue;
    visible.push(access === "metadata" ? { ...row, requirement: "", contentRedacted: true as const } : row);
  }
  return visible;
}

export async function raiseEscalation(db: CoreDb, actor: Actor, taskerId: string, reason: string) {
  if (!reason.trim()) throw new ValidationError("An escalation needs a reason");
  return authorized(db, actor, "escalation.raise", { taskerId }, async (tx) => {
    const row = await mustTasker(tx, taskerId);
    requireUser(actor);
    const [open] = await tx
      .select()
      .from(escalation)
      .where(and(eq(escalation.taskerId, taskerId), isNull(escalation.resolvedAt)))
      .limit(1);
    if (open) {
      await writeAudit(tx, actor, {
        eventType: "escalation.joined",
        entityType: "escalation",
        entityId: open.id,
        taskerId,
        payload: { raised_by: actor.userId, reason: reason.trim() },
      });
      return { escalation: open, joined: true as const, tasker: row };
    }
    const [created] = await tx
      .insert(escalation)
      .values({
        taskerId,
        raisedBy: actor.userId,
        raisedByRole: actor.actingRole,
        reason: reason.trim(),
      })
      .returning();
    await writeAudit(tx, actor, {
      eventType: "escalation.raised",
      entityType: "escalation",
      entityId: created!.id,
      taskerId,
      payload: { reason: reason.trim() },
    });
    return { escalation: created!, joined: false as const, tasker: row };
  });
}

export async function resolveEscalation(db: CoreDb, actor: Actor, escalationId: string, resolution: string) {
  if (!resolution.trim()) throw new ValidationError("A resolution is required");
  const [peek] = await db.select().from(escalation).where(eq(escalation.id, escalationId)).limit(1);
  if (!peek) throw new NotFound("escalation");
  return authorized(db, actor, "escalation.resolve", { taskerId: peek.taskerId }, async (tx) => {
    requireUser(actor);
    const [row] = await tx.select().from(escalation).where(eq(escalation.id, escalationId)).limit(1);
    if (!row || row.resolvedAt) throw new InvalidTransition("Escalation is already resolved");
    const [updated] = await tx
      .update(escalation)
      .set({ resolvedBy: actor.userId, resolution: resolution.trim(), resolvedAt: new Date(), autoClosed: false })
      .where(eq(escalation.id, escalationId))
      .returning();
    await writeAudit(tx, actor, {
      eventType: "escalation.resolved",
      entityType: "escalation",
      entityId: escalationId,
      taskerId: row.taskerId,
      payload: { resolution: resolution.trim() },
    });
    return updated!;
  });
}
