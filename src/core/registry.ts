import { and, eq, isNull } from "drizzle-orm";
import { matching } from "../config/missionflow.config";
import { appUser, org, position, registryEntry, roleGrant } from "../db/schema";
import type { ApplicabilityCriteria, MandatoryCoordination, OrgScope, TimelineProfile } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { NotFound, ValidationError } from "./errors";
import { matchTasker, type MatchEntry, type MatchInput, type MatchResult, type MatchWorld } from "./match";
import { authorized } from "./policy";

export type RegistryInput = {
  id?: string;
  responsibilityId: string;
  missionFunction: string;
  portfolio: string;
  orgScope: OrgScope;
  accountablePositionId: string;
  responsiblePositionId: string;
  designatedAlternatePositionId?: string | null;
  designatedAlternateUserId?: string | null;
  supervisoryPositionId: string;
  mandatoryCoordination?: MandatoryCoordination;
  designatedApproverPositionId: string;
  standardTemplateId?: string | null;
  baselineTimelineProfile: TimelineProfile;
  applicabilityCriteria?: ApplicabilityCriteria | null;
  taskCategories: ("awards_package" | "readiness_data_call" | "rfi" | "staff_summary" | "policy_coordination")[];
  keywords?: string[];
  status?: "draft" | "active" | "expired" | "retired";
  lastValidatedAt?: Date | null;
  validatedBy?: string | null;
};

async function ownedPortfolio(db: CoreDb, actor: Actor): Promise<string | null> {
  if (actor.type !== "user") return null;
  const [grant] = await db
    .select()
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, actor.userId), eq(roleGrant.role, "functional_owner"), isNull(roleGrant.revokedAt)))
    .limit(1);
  return grant?.portfolio ?? null;
}

export async function listEntries(db: CoreDb, filter: { portfolio?: string; status?: string } = {}) {
  const rows = await db.select().from(registryEntry);
  return rows.filter((row) => {
    if (filter.portfolio && row.portfolio !== filter.portfolio) return false;
    if (filter.status && row.status !== filter.status) return false;
    return true;
  });
}

export async function getEntry(db: CoreDb, id: string) {
  const [row] = await db.select().from(registryEntry).where(eq(registryEntry.id, id)).limit(1);
  if (!row) throw new NotFound("registry entry");
  return row;
}

export async function upsertEntry(db: CoreDb, actor: Actor, input: RegistryInput) {
  if (!input.designatedAlternatePositionId && !input.designatedAlternateUserId) {
    throw new ValidationError("A registry entry needs a designated alternate");
  }
  if (input.status === "active" && (!input.lastValidatedAt || !input.validatedBy)) {
    throw new ValidationError("An active entry must already be validated");
  }
  return authorized(db, actor, "registry.upsert", {}, async (tx) => {
    const portfolio = await ownedPortfolio(tx, actor);
    if (portfolio && portfolio !== input.portfolio) throw new ValidationError("Functional owner portfolio does not match this entry");
    const existing = input.id
      ? (await tx.select().from(registryEntry).where(eq(registryEntry.id, input.id)).limit(1))[0]
      : (await tx.select().from(registryEntry).where(eq(registryEntry.responsibilityId, input.responsibilityId)).limit(1))[0];
    const values = {
      responsibilityId: input.responsibilityId,
      missionFunction: input.missionFunction,
      portfolio: input.portfolio,
      orgScope: input.orgScope,
      accountablePositionId: input.accountablePositionId,
      responsiblePositionId: input.responsiblePositionId,
      designatedAlternatePositionId: input.designatedAlternatePositionId ?? null,
      designatedAlternateUserId: input.designatedAlternateUserId ?? null,
      supervisoryPositionId: input.supervisoryPositionId,
      mandatoryCoordination: input.mandatoryCoordination ?? [],
      designatedApproverPositionId: input.designatedApproverPositionId,
      standardTemplateId: input.standardTemplateId ?? null,
      baselineTimelineProfile: input.baselineTimelineProfile,
      applicabilityCriteria: input.applicabilityCriteria ?? null,
      taskCategories: input.taskCategories,
      keywords: input.keywords ?? [],
      status: input.status ?? existing?.status ?? "draft",
      lastValidatedAt: input.lastValidatedAt ?? existing?.lastValidatedAt ?? null,
      validatedBy: input.validatedBy ?? existing?.validatedBy ?? null,
      functionalOwnerUserId: actor.type === "user" ? actor.userId : existing?.functionalOwnerUserId,
      updatedAt: new Date(),
    };
    if (!values.functionalOwnerUserId) throw new ValidationError("Functional owner is required");
    if (existing) {
      const [updated] = await tx.update(registryEntry).set(values).where(eq(registryEntry.id, existing.id)).returning();
      await writeAudit(tx, actor, {
        eventType: "registry.entry_updated",
        entityType: "registry_entry",
        entityId: existing.id,
        payload: { responsibility_id: input.responsibilityId },
      });
      return updated!;
    }
    const [created] = await tx
      .insert(registryEntry)
      .values({ ...values, functionalOwnerUserId: values.functionalOwnerUserId })
      .returning();
    await writeAudit(tx, actor, {
      eventType: "registry.entry_created",
      entityType: "registry_entry",
      entityId: created!.id,
      payload: { responsibility_id: input.responsibilityId },
    });
    return created!;
  });
}

export async function validateEntry(db: CoreDb, actor: Actor, id: string, now = new Date()) {
  return authorized(db, actor, "registry.validate", { entryId: id }, async (tx) => {
    if (actor.type !== "user") throw new ValidationError("A person validates a registry entry");
    const [updated] = await tx
      .update(registryEntry)
      .set({ status: "active", lastValidatedAt: now, validatedBy: actor.userId, updatedAt: now })
      .where(eq(registryEntry.id, id))
      .returning();
    if (!updated) throw new NotFound("registry entry");
    await writeAudit(tx, actor, {
      eventType: "registry.entry_validated",
      entityType: "registry_entry",
      entityId: id,
      payload: { responsibility_id: updated.responsibilityId },
    });
    return updated;
  });
}

export async function retireEntry(db: CoreDb, actor: Actor, id: string) {
  return authorized(db, actor, "registry.retire", { entryId: id }, async (tx) => {
    const [updated] = await tx
      .update(registryEntry)
      .set({ status: "retired", updatedAt: new Date() })
      .where(eq(registryEntry.id, id))
      .returning();
    if (!updated) throw new NotFound("registry entry");
    await writeAudit(tx, actor, {
      eventType: "registry.entry_retired",
      entityType: "registry_entry",
      entityId: id,
      payload: { responsibility_id: updated.responsibilityId },
    });
    return updated;
  });
}

/** System sweep: active entries past the validation window become expired. */
export async function expireStaleEntries(db: CoreDb, now = new Date()) {
  const rows = await db.select().from(registryEntry).where(eq(registryEntry.status, "active"));
  const windowMs = matching.validationCycleDays.quarterly * 86_400_000;
  const expired: string[] = [];
  for (const row of rows) {
    if (!row.lastValidatedAt) continue;
    if (now.getTime() - row.lastValidatedAt.getTime() <= windowMs) continue;
    await db.transaction(async (tx) => {
      await tx.update(registryEntry).set({ status: "expired", updatedAt: now }).where(eq(registryEntry.id, row.id));
      await writeAudit(tx as unknown as CoreDb, { type: "system" }, {
        eventType: "registry.entry_expired",
        entityType: "registry_entry",
        entityId: row.id,
        payload: { responsibility_id: row.responsibilityId },
      });
    });
    expired.push(row.id);
  }
  return expired;
}

function toMatchEntry(row: typeof registryEntry.$inferSelect): MatchEntry {
  return {
    id: row.id,
    responsibilityId: row.responsibilityId,
    missionFunction: row.missionFunction,
    portfolio: row.portfolio,
    orgScope: row.orgScope,
    accountablePositionId: row.accountablePositionId,
    responsiblePositionId: row.responsiblePositionId,
    designatedAlternatePositionId: row.designatedAlternatePositionId,
    designatedAlternateUserId: row.designatedAlternateUserId,
    supervisoryPositionId: row.supervisoryPositionId,
    mandatoryCoordination: row.mandatoryCoordination,
    designatedApproverPositionId: row.designatedApproverPositionId,
    baselineTimelineProfile: row.baselineTimelineProfile,
    applicabilityCriteria: row.applicabilityCriteria,
    lastValidatedAt: row.lastValidatedAt,
    status: row.status,
    taskCategories: row.taskCategories,
    keywords: row.keywords,
  };
}

export async function loadMatchWorld(db: CoreDb, now: Date): Promise<MatchWorld> {
  // Sequential: callers pass a transaction, and one connection cannot run these in parallel.
  const orgs = await db.select().from(org);
  const users = await db.select().from(appUser);
  const positions = await db.select().from(position);
  const entries = await db.select().from(registryEntry);
  const grants = await db.select().from(roleGrant);
  return {
    orgs: orgs.map((row) => ({
      id: row.id,
      echelon: row.echelon,
      parentOrgId: row.parentOrgId,
      missionCodes: row.missionCodes,
    })),
    users: users.map((row) => ({ id: row.id, availability: row.availability, isActive: row.isActive })),
    positions: positions.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      incumbentUserId: row.incumbentUserId,
      alternateUserId: row.alternateUserId,
    })),
    entries: entries.map(toMatchEntry),
    grants: grants.map((row) => ({
      userId: row.userId,
      role: row.role,
      scopeOrgId: row.scopeOrgId,
      revokedAt: row.revokedAt,
    })),
    now,
  };
}

/** Rules-engine match. Unaccepted suggestion rows are not an input. */
export async function match(db: CoreDb, input: MatchInput): Promise<MatchResult> {
  const world = await loadMatchWorld(db, input.now);
  return matchTasker(input, world);
}
