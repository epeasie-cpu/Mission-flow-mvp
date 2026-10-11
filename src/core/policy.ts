import { and, eq, isNull } from "drizzle-orm";
import { appUser, org, registryEntry, roleGrant, tasker, taskerAssignment, gate } from "../db/schema";
import type { Actor } from "./actor";
import { recordAccessDenied } from "./audit";
import type { CoreDb } from "./db";
import { inTx } from "./db";
import { Forbidden } from "./errors";

/**
 * The nine columns of the permission matrix. A cell is yes, no, or conditional.
 * Conditional cells are decided by matrixDecision from the flags below.
 * Disposition ownership in the lifecycle commands follows the disposition table
 * when it is more specific than this summary.
 */
export const MATRIX_ROLES = [
  "enterprise_participant",
  "originator",
  "tasking_authority",
  "accountable_product_owner",
  "ao_primary",
  "ao_alternate",
  "coordinator",
  "sme_contributor",
  "approver",
  "supervisor",
  "functional_owner",
  "task_controller",
  "awareness",
  "system_admin",
  "ai",
] as const;

export const MATRIX_COLUMNS = [
  "create",
  "view",
  "assign",
  "draft",
  "coordinate",
  "approve",
  "disposition",
  "dashboard",
  "registry",
] as const;

export type MatrixRole = (typeof MATRIX_ROLES)[number];
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export type CellKind = "yes" | "no" | "conditional";

const Y = "yes" as const;
const N = "no" as const;
const C = "conditional" as const;

/** create, view, assign, draft, coordinate, approve, disposition, dashboard, registry */
export const MATRIX: Record<MatrixRole, Record<MatrixColumn, CellKind>> = {
  enterprise_participant: { create: N, view: C, assign: N, draft: C, coordinate: N, approve: N, disposition: N, dashboard: C, registry: N },
  originator: { create: Y, view: Y, assign: N, draft: N, coordinate: N, approve: N, disposition: C, dashboard: C, registry: N },
  tasking_authority: { create: Y, view: Y, assign: Y, draft: N, coordinate: N, approve: N, disposition: C, dashboard: Y, registry: N },
  accountable_product_owner: { create: N, view: Y, assign: C, draft: C, coordinate: N, approve: N, disposition: C, dashboard: Y, registry: N },
  ao_primary: { create: N, view: Y, assign: C, draft: Y, coordinate: C, approve: N, disposition: N, dashboard: C, registry: N },
  ao_alternate: { create: N, view: Y, assign: C, draft: C, coordinate: C, approve: N, disposition: N, dashboard: C, registry: N },
  coordinator: { create: N, view: Y, assign: N, draft: C, coordinate: Y, approve: N, disposition: C, dashboard: N, registry: N },
  sme_contributor: { create: N, view: C, assign: N, draft: C, coordinate: N, approve: N, disposition: N, dashboard: N, registry: N },
  approver: { create: N, view: Y, assign: N, draft: C, coordinate: C, approve: Y, disposition: C, dashboard: Y, registry: N },
  supervisor: { create: N, view: Y, assign: Y, draft: N, coordinate: N, approve: N, disposition: C, dashboard: Y, registry: N },
  functional_owner: { create: N, view: Y, assign: Y, draft: N, coordinate: N, approve: N, disposition: C, dashboard: Y, registry: Y },
  task_controller: { create: N, view: Y, assign: C, draft: N, coordinate: N, approve: N, disposition: N, dashboard: Y, registry: N },
  awareness: { create: N, view: Y, assign: N, draft: N, coordinate: N, approve: N, disposition: N, dashboard: C, registry: N },
  system_admin: { create: N, view: C, assign: C, draft: N, coordinate: N, approve: N, disposition: N, dashboard: C, registry: C },
  ai: { create: N, view: C, assign: N, draft: C, coordinate: N, approve: N, disposition: N, dashboard: N, registry: N },
};

export type PolicyCtx = {
  assignedToResource?: boolean;
  ownSmeInput?: boolean;
  ownQueue?: boolean;
  beforeRelease?: boolean;
  dispositionType?: string;
  actingAlternate?: boolean;
  ownGate?: boolean;
  coordinationEnclave?: boolean;
  finalEnclave?: boolean;
  concurrenceGate?: boolean;
  internalQc?: boolean;
  triageRouting?: boolean;
  taskerContent?: boolean;
  roleGrantAdmin?: boolean;
  systemHealth?: boolean;
  technicalOps?: boolean;
  inTaskerInputs?: boolean;
  stampedArtifact?: boolean;
  requestReassignment?: boolean;
  reviewComment?: boolean;
  requestSmeOrCoordinator?: boolean;
  manageGates?: boolean;
};

function flag(ctx: PolicyCtx, key: keyof PolicyCtx): boolean {
  return ctx[key] === true;
}

/** Pure matrix decision. Conditional cells read only the flags in PolicyCtx. */
export function matrixDecision(role: MatrixRole, column: MatrixColumn, ctx: PolicyCtx = {}): boolean {
  const kind = MATRIX[role][column];
  if (kind === "yes") return true;
  if (kind === "no") return false;
  switch (`${role}.${column}`) {
    case "enterprise_participant.view":
      return flag(ctx, "assignedToResource");
    case "enterprise_participant.draft":
      return flag(ctx, "ownSmeInput");
    case "enterprise_participant.dashboard":
      return flag(ctx, "ownQueue");
    case "originator.disposition":
      return ctx.dispositionType === "cancelled_obe" && flag(ctx, "beforeRelease");
    case "originator.dashboard":
      return flag(ctx, "ownQueue");
    case "tasking_authority.disposition":
      return ctx.dispositionType === "cancelled_obe" || ctx.dispositionType === "reassigned";
    case "accountable_product_owner.assign":
      return flag(ctx, "requestReassignment");
    case "accountable_product_owner.draft":
      return flag(ctx, "reviewComment");
    case "accountable_product_owner.disposition":
      return ctx.dispositionType === "returned_for_rework";
    case "ao_primary.assign":
      return flag(ctx, "requestSmeOrCoordinator");
    case "ao_primary.coordinate":
      return flag(ctx, "manageGates");
    case "ao_primary.dashboard":
      return flag(ctx, "ownQueue");
    case "ao_alternate.assign":
    case "ao_alternate.draft":
    case "ao_alternate.coordinate":
    case "ao_alternate.dashboard":
      return flag(ctx, "actingAlternate");
    case "coordinator.draft":
      return flag(ctx, "coordinationEnclave");
    case "coordinator.disposition":
      return flag(ctx, "ownGate") && (ctx.dispositionType === "concurred" || ctx.dispositionType === "nonconcurred");
    case "sme_contributor.view":
    case "sme_contributor.draft":
      return flag(ctx, "ownSmeInput");
    case "approver.draft":
      return flag(ctx, "finalEnclave");
    case "approver.coordinate":
      return flag(ctx, "concurrenceGate");
    case "approver.disposition":
      return (
        ctx.dispositionType === "completed" ||
        ctx.dispositionType === "submitted" ||
        ctx.dispositionType === "returned_for_rework"
      );
    case "supervisor.disposition":
      return ctx.dispositionType === "reassigned" || (ctx.dispositionType === "returned_for_rework" && flag(ctx, "internalQc"));
    case "functional_owner.disposition":
      return ctx.dispositionType === "no_equity_validated" || ctx.dispositionType === "reassigned";
    case "task_controller.assign":
      return flag(ctx, "triageRouting");
    case "awareness.dashboard":
      return flag(ctx, "ownQueue");
    case "system_admin.view":
      return !flag(ctx, "taskerContent");
    case "system_admin.assign":
      return flag(ctx, "roleGrantAdmin");
    case "system_admin.dashboard":
      return flag(ctx, "systemHealth");
    case "system_admin.registry":
      return flag(ctx, "technicalOps");
    case "ai.view":
      return flag(ctx, "inTaskerInputs");
    case "ai.draft":
      return flag(ctx, "stampedArtifact");
    default:
      return false;
  }
}

const AI_BLOCKED = new Set([
  "tasker.release",
  "tasker.disposition",
  "tasker.sign",
  "tasker.reassign",
  "tasker.cancel",
  "tasker.change_suspense",
  "tasker.resolve_suspense",
  "tasker.change_transmit",
  "gate.add",
  "gate.decide",
  "gate.open",
  "assignment.assign",
  "assignment.failover",
  "escalation.raise",
  "escalation.resolve",
  "ai.verify",
]);

export type ResourceRef = { taskerId?: string; entryId?: string; gateId?: string };

async function ancestorIds(db: CoreDb, orgId: string): Promise<Set<string>> {
  const orgs = await db.select({ id: org.id, parentOrgId: org.parentOrgId }).from(org);
  const byId = new Map(orgs.map((row) => [row.id, row.parentOrgId]));
  const ids = new Set<string>();
  let cursor: string | null = orgId;
  while (cursor && !ids.has(cursor)) {
    ids.add(cursor);
    cursor = byId.get(cursor) ?? null;
  }
  return ids;
}

/** Roles this user may switch to. Originator is offered when the billet says so, or they already originated a tasker. */
export async function listHeldRoles(db: CoreDb, userId: string): Promise<string[]> {
  const roles = new Set<string>(["enterprise_participant"]);
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user) return [];
  if (/originator/i.test(user.billetLabel ?? "")) roles.add("originator");
  const grants = await db
    .select()
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, userId), isNull(roleGrant.revokedAt)));
  for (const grant of grants) roles.add(grant.role);
  const assignments = await db
    .select({ role: taskerAssignment.role })
    .from(taskerAssignment)
    .where(and(eq(taskerAssignment.userId, userId), eq(taskerAssignment.active, true)));
  for (const assignment of assignments) roles.add(assignment.role);
  const originated = await db
    .select({ id: tasker.id })
    .from(tasker)
    .where(eq(tasker.originatorId, userId))
    .limit(1);
  if (originated.length > 0) roles.add("originator");
  return [...roles];
}

async function coversOrg(db: CoreDb, scopeOrgId: string | null, targetOrgId: string): Promise<boolean> {
  if (!scopeOrgId) return true;
  const chain = await ancestorIds(db, targetOrgId);
  return chain.has(scopeOrgId);
}

/**
 * Command-level permission. Tasker-scoped roles must be held on the resource tasker.
 * The AI actor is rejected on assignment, release, gates, dispositions, suspense, and escalation.
 */
export async function can(db: CoreDb, actor: Actor, action: string, resource: ResourceRef = {}): Promise<boolean> {
  if (actor.type === "ai") return !AI_BLOCKED.has(action) && action === "ai.suggest";
  if (actor.type === "system") return action.startsWith("system.");
  const held = await listHeldRoles(db, actor.userId);
  if (!held.includes(actor.actingRole)) return false;

  const [row] = resource.taskerId
    ? await db.select().from(tasker).where(eq(tasker.id, resource.taskerId)).limit(1)
    : [undefined];
  const assignments = resource.taskerId
    ? await db
        .select()
        .from(taskerAssignment)
        .where(and(eq(taskerAssignment.taskerId, resource.taskerId), eq(taskerAssignment.active, true)))
    : [];
  const mine = assignments.filter((item) => item.userId === actor.userId);
  const hasRole = (role: string) => mine.some((item) => item.role === role);
  const grants = await db
    .select()
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, actor.userId), isNull(roleGrant.revokedAt)));
  const hasGrant = (role: string) => grants.some((item) => item.role === role);

  let orgOk = false;
  let portfolioOk = false;
  if (row) {
    orgOk = (
      await Promise.all(
        grants
          .filter((item) => item.role === actor.actingRole || item.role === "tasking_authority" || item.role === "supervisor" || item.role === "approver")
          .map((item) => coversOrg(db, item.scopeOrgId, row.targetOrgId)),
      )
    ).some(Boolean);
    if (hasGrant("functional_owner")) {
      const entry = row.registryEntryId
        ? (await db.select().from(registryEntry).where(eq(registryEntry.id, row.registryEntryId)).limit(1))[0]
        : undefined;
      portfolioOk = grants.some(
        (item) =>
          item.role === "functional_owner" &&
          (item.portfolio == null || item.portfolio === row.portfolio || item.portfolio === entry?.portfolio),
      );
    }
  }

  const role = actor.actingRole;
  const released = Boolean(row?.releasedAt);
  const awarenessOnly = hasRole("awareness") && mine.every((item) => item.role === "awareness");

  if (action === "tasker.view") {
    if (role === "system_admin") return false;
    if (role === "task_controller" && hasGrant("task_controller")) return true;
    if (mine.length > 0) return true;
    if ((role === "tasking_authority" || role === "supervisor" || role === "approver") && orgOk) return true;
    if (role === "functional_owner" && portfolioOk) return true;
    return false;
  }

  if (awarenessOnly && (action.startsWith("gate.") || action.startsWith("tasker.disposition") || action === "tasker.sign")) {
    return false;
  }

  switch (action) {
    case "tasker.create":
      return role === "originator" || role === "tasking_authority";
    case "tasker.update_draft":
    case "tasker.submit":
    case "tasker.cancel_prerelease":
      return role === "originator" && !!row && row.originatorId === actor.userId && !released;
    case "tasker.release":
    case "tasker.change_transmit":
    case "tasker.resolve_suspense":
    case "tasker.change_suspense":
      return role === "tasking_authority" && hasGrant("tasking_authority");
    case "tasker.accept":
    case "tasker.acknowledge":
    case "tasker.clarify":
    case "tasker.claim_no_equity":
    case "tasker.elevate":
    case "tasker.route_approval":
    case "tasker.open_coordination":
    case "tasker.reopen_coordination":
    case "ai.generate":
    case "ai.verify":
    case "sme.request":
    case "gate.add":
    case "gate.open":
      return role === "ao_primary" && hasRole("ao_primary");
    case "tasker.answer_clarification":
      return role === "originator" && !!row && row.originatorId === actor.userId;
    case "tasker.reassign":
      return (
        (role === "supervisor" && hasGrant("supervisor")) ||
        (role === "functional_owner" && hasGrant("functional_owner")) ||
        (role === "tasking_authority" && hasGrant("tasking_authority"))
      );
    case "tasker.cancel":
      if (role === "tasking_authority" && hasGrant("tasking_authority")) return true;
      return role === "originator" && !!row && row.originatorId === actor.userId && !released;
    case "tasker.sign":
      return role === "approver" && (hasRole("approver") || (hasGrant("approver") && orgOk));
    case "tasker.return_rework":
      return (
        (role === "approver" && (hasRole("approver") || hasGrant("approver"))) ||
        (role === "accountable_product_owner" && hasRole("accountable_product_owner")) ||
        (role === "supervisor" && hasGrant("supervisor"))
      );
    case "tasker.no_equity":
    case "tasker.adjudicate":
      return role === "functional_owner" && hasGrant("functional_owner");
    case "tasker.disposition.concurred":
    case "tasker.disposition.nonconcurred":
    case "gate.decide":
      return (role === "coordinator" && hasRole("coordinator")) || (role === "approver" && hasRole("approver"));
    case "escalation.raise":
      return (
        (role === "ao_primary" && hasRole("ao_primary")) ||
        (role === "accountable_product_owner" && hasRole("accountable_product_owner")) ||
        (role === "supervisor" && hasGrant("supervisor")) ||
        (role === "task_controller" && hasGrant("task_controller"))
      );
    case "escalation.resolve":
      return (role === "supervisor" && hasGrant("supervisor")) || (role === "tasking_authority" && hasGrant("tasking_authority"));
    case "assignment.assign":
      return (
        (role === "supervisor" && hasGrant("supervisor")) ||
        (role === "tasking_authority" && hasGrant("tasking_authority")) ||
        (role === "functional_owner" && hasGrant("functional_owner")) ||
        (role === "ao_primary" && hasRole("ao_primary"))
      );
    case "assignment.failover":
      return (role === "supervisor" && hasGrant("supervisor")) || (role === "tasking_authority" && hasGrant("tasking_authority"));
    case "registry.upsert":
    case "registry.validate":
    case "registry.retire":
      return role === "functional_owner" && hasGrant("functional_owner");
    case "sme.submit":
    case "sme.decline":
      return role === "sme_contributor" && hasRole("sme_contributor");
    case "docs.upload":
    case "docs.version":
    case "docs.checkout":
      return mine.length > 0 && !hasRole("awareness") && role !== "system_admin" && role !== "task_controller";
    case "docs.lock":
      return role === "approver" && (hasRole("approver") || hasGrant("approver"));
    case "admin.grant":
      return role === "system_admin" && hasGrant("system_admin");
    default:
      return false;
  }
}

export async function authorized<T>(
  db: CoreDb,
  actor: Actor,
  action: string,
  resource: ResourceRef,
  fn: (tx: CoreDb) => Promise<T>,
): Promise<T> {
  if (actor.type !== "system") {
    const allowed = await can(db, actor, action, resource);
    if (!allowed) {
      await recordAccessDenied(db, actor, action, resource);
      throw new Forbidden(action);
    }
  }
  try {
    return await inTx(db, fn);
  } catch (err) {
    if (err instanceof Forbidden) await recordAccessDenied(db, actor, action, resource);
    throw err;
  }
}

/** Visibility for reads. System admin never receives tasker content. Everyone else who fails the check is NotFound at the call site. */
export async function canViewTasker(db: CoreDb, actor: Actor, taskerId: string): Promise<"full" | "metadata" | "none"> {
  if (actor.type !== "user") return "none";
  if (actor.actingRole === "system_admin") return "none";
  const allowed = await can(db, actor, "tasker.view", { taskerId });
  if (!allowed) return "none";
  if (actor.actingRole === "task_controller") return "metadata";
  return "full";
}

export async function gateAssignee(db: CoreDb, gateId: string, userId: string): Promise<boolean> {
  const [row] = await db.select().from(gate).where(eq(gate.id, gateId)).limit(1);
  return row?.assigneeUserId === userId;
}
