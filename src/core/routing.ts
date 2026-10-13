import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { businessToday, pilot, type TaskCategory } from "../config/missionflow.config";
import { additionalDuty, appUser, org, tasker, taskerAssignment } from "../db/schema";
import type { RoutingCriteria } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { authorized } from "./policy";
import { ValidationError } from "./errors";
import { insertStoredDocument, type UploadInput } from "./files";
import { fanOutTaskingNotices } from "./notify";
import { descendantOrgIds } from "./personnel";
import { addAssignment } from "./tasker-store";

export type { RoutingCriteria };

export type ActionOfficerMatch = {
  id: string;
  displayName: string;
  rank: string | null;
  email: string;
  orgId: string;
  orgName: string;
  billetLabel: string | null;
  afsc: string | null;
  primaryDuty: string | null;
  duties: string[];
  leadershipTitle: string | null;
};

export function normalizeCriteria(input: Partial<RoutingCriteria> | null | undefined): RoutingCriteria {
  const unique = (values: string[] | undefined) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  return {
    orgIds: unique(input?.orgIds),
    afscs: unique(input?.afscs).map((value) => value.toUpperCase()),
    duty: (input?.duty ?? "").trim(),
    additionalDuty: (input?.additionalDuty ?? "").trim().replace(/\s+/g, " "),
    userIds: unique(input?.userIds),
  };
}

export function criteriaIsEmpty(criteria: RoutingCriteria): boolean {
  return (
    criteria.orgIds.length === 0 &&
    criteria.afscs.length === 0 &&
    criteria.duty.length === 0 &&
    criteria.additionalDuty.length === 0 &&
    criteria.userIds.length === 0
  );
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function matchActionOfficers(db: CoreDb, raw: Partial<RoutingCriteria>): Promise<ActionOfficerMatch[]> {
  const criteria = normalizeCriteria(raw);
  if (criteriaIsEmpty(criteria)) return [];
  const [users, orgs, dutyRows] = await Promise.all([
    db.select().from(appUser).where(eq(appUser.isActive, true)).orderBy(asc(appUser.displayName)),
    db.select({ id: org.id, name: org.name, echelon: org.echelon, parentOrgId: org.parentOrgId }).from(org),
    db.select({ userId: additionalDuty.userId, name: additionalDuty.name }).from(additionalDuty).where(isNull(additionalDuty.endedAt)),
  ]);
  const orgName = new Map(orgs.map((row) => [row.id, row.name]));
  const duties = new Map<string, string[]>();
  for (const row of dutyRows) {
    const list = duties.get(row.userId) ?? [];
    list.push(row.name);
    duties.set(row.userId, list);
  }
  const orgLimit = criteria.orgIds.length ? descendantOrgIds(orgs, criteria.orgIds) : null;
  const dutyNeedle = norm(criteria.duty);
  const extraNeedle = norm(criteria.additionalDuty);
  const hasFilter = Boolean(orgLimit || criteria.afscs.length || dutyNeedle || extraNeedle);
  const byId = new Map(users.map((user) => [user.id, user]));

  const toMatch = (user: (typeof users)[number]): ActionOfficerMatch => ({
    id: user.id,
    displayName: user.displayName,
    rank: user.rank,
    email: user.email,
    orgId: user.orgId,
    orgName: orgName.get(user.orgId) ?? "—",
    billetLabel: user.billetLabel,
    afsc: user.afsc,
    primaryDuty: user.primaryDuty,
    duties: duties.get(user.id) ?? [],
    leadershipTitle: user.leadershipTitle,
  });

  const passes = (user: (typeof users)[number]): boolean => {
    if (user.availability !== "available") return false;
    if (orgLimit && !orgLimit.has(user.orgId)) return false;
    if (criteria.afscs.length && !criteria.afscs.some((code) => code.toLowerCase() === (user.afsc ?? "").toLowerCase())) return false;
    if (dutyNeedle) {
      const hay = [user.primaryDuty, user.billetLabel, user.leadershipTitle, ...(user.functions ?? [])]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!hay.includes(dutyNeedle)) return false;
    }
    if (extraNeedle && !(duties.get(user.id) ?? []).some((name) => norm(name) === extraNeedle)) return false;
    return true;
  };

  const chosen = new Map<string, ActionOfficerMatch>();
  if (hasFilter) {
    for (const user of users) {
      if (passes(user)) chosen.set(user.id, toMatch(user));
    }
  }
  for (const userId of criteria.userIds) {
    const user = byId.get(userId);
    if (user) chosen.set(user.id, toMatch(user));
  }
  return [...chosen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function nextRef(db: CoreDb, now: Date): Promise<string> {
  const year = businessToday(now).slice(0, 4);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(tasker);
  return `MF-${year}-${String(Number(count?.n ?? 0) + 1).padStart(4, "0")}`;
}

function requireUser(actor: Actor): asserts actor is { type: "user"; userId: string; actingRole: string } {
  if (actor.type !== "user") throw new ValidationError("A person performs this command");
}

export type IssuedTasker = {
  id: string;
  ref: string;
  assigneeId: string;
  assigneeName: string;
};

export async function issueRoutedTasking(
  db: CoreDb,
  actor: Actor,
  input: {
    title: string;
    description: string;
    externalSuspense: string;
    priority: "routine" | "priority";
    category: TaskCategory;
    criteria: Partial<RoutingCriteria>;
    files?: UploadInput[];
    now?: Date;
  },
): Promise<{ batchId: string; taskers: IssuedTasker[] }> {
  const criteria = normalizeCriteria(input.criteria);
  if (criteriaIsEmpty(criteria)) throw new ValidationError("Add routing criteria before submitting");
  if (!pilot.enabledCategories.includes(input.category)) throw new ValidationError("Category is outside the pilot");
  if (!input.title.trim() || !input.description.trim()) throw new ValidationError("Title and description are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.externalSuspense)) throw new ValidationError("Suspense date must be YYYY-MM-DD");
  const files = input.files ?? [];
  const matches = await matchActionOfficers(db, criteria);
  if (matches.length === 0) throw new ValidationError("No action officers matched the routing criteria");

  return authorized(db, actor, "tasker.create", {}, async (tx) => {
    requireUser(actor);
    const batchId = randomUUID();
    const now = input.now ?? new Date();
    const missionFunction = (criteria.additionalDuty || criteria.duty || "directed tasking").slice(0, 200);
    const issued: IssuedTasker[] = [];
    for (const match of matches) {
      const ref = await nextRef(tx, now);
      const [created] = await tx
        .insert(tasker)
        .values({
          ref,
          title: input.title.trim(),
          category: input.category,
          missionFunction,
          portfolio: input.category === "awards_package" ? "notional awards" : null,
          targetOrgId: match.orgId,
          requirement: input.description.trim(),
          deliverableFormat: "Task package",
          externalSuspense: input.externalSuspense,
          priority: input.priority,
          originatorId: actor.userId,
          taskingAuthorityId: actor.actingRole === "tasking_authority" ? actor.userId : null,
          state: "ASSIGNED",
          submittedForReleaseAt: now,
          routingBatchId: batchId,
          routingCriteria: criteria,
        })
        .returning();
      if (!created) throw new Error("tasker insert failed");
      await writeAudit(tx, actor, {
        eventType: "tasker.created",
        entityType: "tasker",
        entityId: created.id,
        taskerId: created.id,
        payload: { ref, category: input.category, state: "ASSIGNED", routing_batch_id: batchId },
      });
      await addAssignment(tx, actor, {
        taskerId: created.id,
        userId: actor.userId,
        role: "originator",
        source: "manual",
        rationale: "Opened the routed tasker",
        assignedBy: actor.userId,
      });
      await addAssignment(tx, actor, {
        taskerId: created.id,
        userId: match.id,
        role: "ao_primary",
        source: "manual",
        rationale: "Matched by routing criteria",
        assignedBy: actor.userId,
      });
      await writeAudit(tx, actor, {
        eventType: "tasker.routed",
        entityType: "tasker",
        entityId: created.id,
        taskerId: created.id,
        payload: {
          routing_batch_id: batchId,
          assignee_user_id: match.id,
          criteria,
        },
      });
      await fanOutTaskingNotices(tx, actor, {
        taskerId: created.id,
        assigneeId: match.id,
        title: created.title,
        suspense: created.externalSuspense,
      });
      for (const file of files) {
        await insertStoredDocument(tx, actor, created.id, file);
      }
      issued.push({ id: created.id, ref, assigneeId: match.id, assigneeName: match.displayName });
    }
    return { batchId, taskers: issued };
  });
}

export async function listRoutingBatch(db: CoreDb, taskerId: string): Promise<{ id: string; ref: string; aoName: string | null }[]> {
  const [current] = await db.select({ routingBatchId: tasker.routingBatchId }).from(tasker).where(eq(tasker.id, taskerId)).limit(1);
  if (!current?.routingBatchId) return [];
  const rows = await db
    .select({ id: tasker.id, ref: tasker.ref })
    .from(tasker)
    .where(eq(tasker.routingBatchId, current.routingBatchId))
    .orderBy(asc(tasker.ref));
  const mates = [];
  for (const row of rows) {
    const [assignment] = await db
      .select({ name: appUser.displayName })
      .from(taskerAssignment)
      .innerJoin(appUser, eq(appUser.id, taskerAssignment.userId))
      .where(and(eq(taskerAssignment.taskerId, row.id), eq(taskerAssignment.role, "ao_primary"), eq(taskerAssignment.active, true)))
      .limit(1);
    mates.push({ id: row.id, ref: row.ref, aoName: assignment?.name ?? null });
  }
  return mates;
}
