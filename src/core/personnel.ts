import { and, asc, eq, isNull } from "drizzle-orm";
import { additionalDuty, appUser, org, roleGrant } from "../db/schema";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { authorized } from "./policy";
import { NotFound, ValidationError } from "./errors";

const LEADER_TITLE = /commander|program manager|flight chief|superintendent|director/i;
const LEADER_ROLES = new Set(["supervisor", "approver", "functional_owner"]);

export function isChainLeader(input: { leadershipTitle: string | null; roles: string[] }): boolean {
  if (input.leadershipTitle && LEADER_TITLE.test(input.leadershipTitle)) return true;
  return input.roles.some((role) => LEADER_ROLES.has(role));
}

export type DirectoryFilters = {
  orgId?: string | null;
  afsc?: string | null;
  additionalDuty?: string | null;
};

export type DirectoryRow = {
  id: string;
  displayName: string;
  rank: string | null;
  email: string;
  orgId: string;
  orgName: string;
  orgEchelon: string;
  billetLabel: string | null;
  afsc: string | null;
  primaryDuty: string | null;
  leadershipTitle: string | null;
  duties: string[];
  availability: string;
};

export type ChainLink = {
  id: string;
  displayName: string;
  rank: string | null;
  billetLabel: string | null;
  leadershipTitle: string | null;
  orgId: string;
  orgName: string;
};

export type PersonProfile = {
  person: DirectoryRow & {
    functions: string[];
    supervisorUserId: string | null;
  };
  orgPath: { id: string; name: string; echelon: string }[];
  chain: ChainLink[];
  reports: { id: string; displayName: string; rank: string | null; billetLabel: string | null }[];
};

export type PersonInput = {
  displayName: string;
  email: string;
  orgId: string;
  rank: string;
  billetLabel: string;
  afsc: string;
  primaryDuty: string;
  functions: string[];
  supervisorUserId: string | null;
  leadershipTitle: string | null;
  duties: string[];
  availability?: "available" | "tdy" | "deployed" | "leave" | "reassigned";
};

type OrgRow = { id: string; name: string; echelon: string; parentOrgId: string | null };

function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function requireUser(actor: Actor): asserts actor is { type: "user"; userId: string; actingRole: string } {
  if (actor.type !== "user") throw new ValidationError("A person performs this command");
}

function assertEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@example\.test$/.test(value)) throw new ValidationError("Email must use @example.test");
  return value;
}

async function loadOrgs(db: CoreDb): Promise<OrgRow[]> {
  return db.select({ id: org.id, name: org.name, echelon: org.echelon, parentOrgId: org.parentOrgId }).from(org);
}

export function descendantOrgIds(orgs: OrgRow[], roots: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const row of orgs) {
    if (!row.parentOrgId) continue;
    const list = children.get(row.parentOrgId) ?? [];
    list.push(row.id);
    children.set(row.parentOrgId, list);
  }
  const ids = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const current = stack.pop();
    if (!current || ids.has(current)) continue;
    ids.add(current);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  return ids;
}

function ancestorOrgIds(orgs: OrgRow[], orgId: string): Set<string> {
  const parent = new Map(orgs.map((row) => [row.id, row.parentOrgId]));
  const ids = new Set<string>();
  let cursor = parent.get(orgId) ?? null;
  while (cursor && !ids.has(cursor)) {
    ids.add(cursor);
    cursor = parent.get(cursor) ?? null;
  }
  return ids;
}

function orgPath(orgs: OrgRow[], orgId: string): OrgRow[] {
  const byId = new Map(orgs.map((row) => [row.id, row]));
  const path: OrgRow[] = [];
  let cursor: string | null = orgId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byId.get(cursor);
    if (!row) break;
    path.push(row);
    cursor = row.parentOrgId;
  }
  return path.reverse();
}

async function activeDuties(db: CoreDb): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ userId: additionalDuty.userId, name: additionalDuty.name })
    .from(additionalDuty)
    .where(isNull(additionalDuty.endedAt))
    .orderBy(asc(additionalDuty.name));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(row.name);
    map.set(row.userId, list);
  }
  return map;
}

export async function listDirectory(db: CoreDb, filters: DirectoryFilters = {}): Promise<DirectoryRow[]> {
  const [users, orgs, duties] = await Promise.all([
    db.select().from(appUser).where(eq(appUser.isActive, true)).orderBy(asc(appUser.displayName)),
    loadOrgs(db),
    activeDuties(db),
  ]);
  const orgById = new Map(orgs.map((row) => [row.id, row]));
  const orgLimit = filters.orgId ? descendantOrgIds(orgs, [filters.orgId]) : null;
  const afsc = filters.afsc?.trim().toLowerCase() ?? "";
  const duty = filters.additionalDuty?.trim().toLowerCase() ?? "";
  const rows: DirectoryRow[] = [];
  for (const user of users) {
    if (orgLimit && !orgLimit.has(user.orgId)) continue;
    if (afsc && (user.afsc ?? "").toLowerCase() !== afsc) continue;
    const userDuties = duties.get(user.id) ?? [];
    if (duty && !userDuties.some((name) => name.toLowerCase() === duty)) continue;
    const unit = orgById.get(user.orgId);
    rows.push({
      id: user.id,
      displayName: user.displayName,
      rank: user.rank,
      email: user.email,
      orgId: user.orgId,
      orgName: unit?.name ?? "—",
      orgEchelon: unit?.echelon ?? "",
      billetLabel: user.billetLabel,
      afsc: user.afsc,
      primaryDuty: user.primaryDuty,
      leadershipTitle: user.leadershipTitle,
      duties: userDuties,
      availability: user.availability,
    });
  }
  return rows;
}

export async function listOrgUnits(db: CoreDb): Promise<{ id: string; name: string; shortCode: string; echelon: string; parentOrgId: string | null }[]> {
  return db
    .select({ id: org.id, name: org.name, shortCode: org.shortCode, echelon: org.echelon, parentOrgId: org.parentOrgId })
    .from(org)
    .orderBy(asc(org.name));
}

export async function listDutyNames(db: CoreDb): Promise<string[]> {
  const rows = await db
    .select({ name: additionalDuty.name })
    .from(additionalDuty)
    .where(isNull(additionalDuty.endedAt))
    .orderBy(asc(additionalDuty.name));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(row.name);
  }
  return names;
}

export async function getPersonProfile(db: CoreDb, userId: string): Promise<PersonProfile | null> {
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user || !user.isActive) return null;
  const [orgs, duties, users] = await Promise.all([
    loadOrgs(db),
    activeDuties(db),
    db.select().from(appUser).where(eq(appUser.isActive, true)),
  ]);
  const orgById = new Map(orgs.map((row) => [row.id, row]));
  const unit = orgById.get(user.orgId);
  const byId = new Map(users.map((row) => [row.id, row]));
  const chainUp: ChainLink[] = [];
  const seen = new Set<string>();
  let cursor: string | null = user.id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const current = byId.get(cursor);
    if (!current) break;
    const currentOrg = orgById.get(current.orgId);
    chainUp.push({
      id: current.id,
      displayName: current.displayName,
      rank: current.rank,
      billetLabel: current.billetLabel,
      leadershipTitle: current.leadershipTitle,
      orgId: current.orgId,
      orgName: currentOrg?.name ?? "—",
    });
    cursor = current.supervisorUserId;
  }
  const reports = users
    .filter((row) => row.supervisorUserId === user.id)
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      rank: row.rank,
      billetLabel: row.billetLabel,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    person: {
      id: user.id,
      displayName: user.displayName,
      rank: user.rank,
      email: user.email,
      orgId: user.orgId,
      orgName: unit?.name ?? "—",
      orgEchelon: unit?.echelon ?? "",
      billetLabel: user.billetLabel,
      afsc: user.afsc,
      primaryDuty: user.primaryDuty,
      leadershipTitle: user.leadershipTitle,
      duties: duties.get(user.id) ?? [],
      availability: user.availability,
      functions: user.functions,
      supervisorUserId: user.supervisorUserId,
    },
    orgPath: orgPath(orgs, user.orgId).map((row) => ({ id: row.id, name: row.name, echelon: row.echelon })),
    chain: chainUp.reverse(),
    reports,
  };
}

export type ChainLeader = {
  id: string;
  displayName: string;
  email: string;
  leadershipTitle: string | null;
};

/** Leaders above an action officer: supervisor chain, same org, and ancestor orgs. */
export async function leadersToNotify(db: CoreDb, userId: string): Promise<ChainLeader[]> {
  const [users, orgs, grants] = await Promise.all([
    db.select().from(appUser).where(eq(appUser.isActive, true)),
    loadOrgs(db),
    db.select({ userId: roleGrant.userId, role: roleGrant.role }).from(roleGrant).where(isNull(roleGrant.revokedAt)),
  ]);
  const subject = users.find((row) => row.id === userId);
  if (!subject) return [];
  const rolesByUser = new Map<string, string[]>();
  for (const grant of grants) {
    const list = rolesByUser.get(grant.userId) ?? [];
    list.push(grant.role);
    rolesByUser.set(grant.userId, list);
  }
  const leaderIds = new Set<string>();
  const seen = new Set<string>([subject.id]);
  let cursor = subject.supervisorUserId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    leaderIds.add(cursor);
    cursor = users.find((row) => row.id === cursor)?.supervisorUserId ?? null;
  }
  const ancestors = ancestorOrgIds(orgs, subject.orgId);
  ancestors.add(subject.orgId);
  for (const row of users) {
    if (row.id === subject.id) continue;
    if (ancestors.has(row.orgId)) leaderIds.add(row.id);
  }
  const leaders: ChainLeader[] = [];
  for (const id of leaderIds) {
    const row = users.find((item) => item.id === id);
    if (!row) continue;
    if (!isChainLeader({ leadershipTitle: row.leadershipTitle, roles: rolesByUser.get(row.id) ?? [] })) continue;
    leaders.push({
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      leadershipTitle: row.leadershipTitle,
    });
  }
  leaders.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return leaders;
}

async function assertOrg(db: CoreDb, orgId: string): Promise<void> {
  const [row] = await db.select({ id: org.id }).from(org).where(eq(org.id, orgId)).limit(1);
  if (!row) throw new ValidationError("Org unit was not found");
}

async function assertSupervisor(db: CoreDb, userId: string | null, supervisorUserId: string | null): Promise<void> {
  if (!supervisorUserId) return;
  if (userId && supervisorUserId === userId) throw new ValidationError("A person cannot supervise themselves");
  const users = await db.select({ id: appUser.id, supervisorUserId: appUser.supervisorUserId }).from(appUser);
  if (!users.some((row) => row.id === supervisorUserId)) throw new ValidationError("Supervisor was not found");
  const parent = new Map(users.map((row) => [row.id, row.supervisorUserId]));
  const seen = new Set<string>();
  if (userId) seen.add(userId);
  let cursor: string | null = supervisorUserId;
  while (cursor) {
    if (seen.has(cursor)) throw new ValidationError("That supervisor would create a cycle");
    seen.add(cursor);
    cursor = parent.get(cursor) ?? null;
  }
}

async function syncDuties(db: CoreDb, userId: string, names: string[]): Promise<string[]> {
  const wanted = new Map<string, string>();
  for (const name of cleanList(names)) wanted.set(name.toLowerCase(), name);
  const current = await db
    .select()
    .from(additionalDuty)
    .where(and(eq(additionalDuty.userId, userId), isNull(additionalDuty.endedAt)));
  const now = new Date();
  for (const row of current) {
    const key = row.name.toLowerCase();
    if (wanted.has(key)) wanted.delete(key);
    else await db.update(additionalDuty).set({ endedAt: now }).where(eq(additionalDuty.id, row.id));
  }
  for (const name of wanted.values()) {
    await db.insert(additionalDuty).values({ userId, name });
  }
  return cleanList(names);
}

function snapshot(user: typeof appUser.$inferSelect, duties: string[]) {
  return {
    display_name: user.displayName,
    email: user.email,
    org_id: user.orgId,
    rank: user.rank,
    billet_label: user.billetLabel,
    afsc: user.afsc,
    primary_duty: user.primaryDuty,
    functions: user.functions,
    supervisor_user_id: user.supervisorUserId,
    leadership_title: user.leadershipTitle,
    availability: user.availability,
    duties,
  };
}

function normalizeInput(input: PersonInput) {
  const displayName = input.displayName.trim();
  const billetLabel = input.billetLabel.trim();
  if (!displayName || !billetLabel) throw new ValidationError("Name and duty position are required");
  return {
    displayName,
    email: assertEmail(input.email),
    orgId: input.orgId,
    rank: input.rank.trim() || null,
    billetLabel,
    afsc: input.afsc.trim() || null,
    primaryDuty: input.primaryDuty.trim() || null,
    functions: cleanList(input.functions),
    supervisorUserId: input.supervisorUserId,
    leadershipTitle: input.leadershipTitle?.trim() || null,
    duties: cleanList(input.duties),
    availability: input.availability ?? "available",
  };
}

export async function createPerson(db: CoreDb, actor: Actor, input: PersonInput) {
  const fields = normalizeInput(input);
  await assertOrg(db, fields.orgId);
  await assertSupervisor(db, null, fields.supervisorUserId);
  return authorized(db, actor, "personnel.manage", {}, async (tx) => {
    requireUser(actor);
    const [created] = await tx
      .insert(appUser)
      .values({
        displayName: fields.displayName,
        email: fields.email,
        orgId: fields.orgId,
        rank: fields.rank,
        billetLabel: fields.billetLabel,
        afsc: fields.afsc,
        primaryDuty: fields.primaryDuty,
        functions: fields.functions,
        supervisorUserId: fields.supervisorUserId,
        leadershipTitle: fields.leadershipTitle,
        availability: fields.availability,
      })
      .returning();
    if (!created) throw new Error("personnel insert failed");
    const duties = await syncDuties(tx, created.id, fields.duties);
    await writeAudit(tx, actor, {
      eventType: "personnel.created",
      entityType: "user",
      entityId: created.id,
      payload: { after: snapshot(created, duties) },
    });
    return created;
  });
}

export async function updatePerson(db: CoreDb, actor: Actor, userId: string, input: PersonInput) {
  const fields = normalizeInput(input);
  await assertOrg(db, fields.orgId);
  await assertSupervisor(db, userId, fields.supervisorUserId);
  return authorized(db, actor, "personnel.manage", {}, async (tx) => {
    requireUser(actor);
    const [before] = await tx.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
    if (!before || !before.isActive) throw new NotFound("persona");
    const priorDuties = (
      await tx
        .select({ name: additionalDuty.name })
        .from(additionalDuty)
        .where(and(eq(additionalDuty.userId, userId), isNull(additionalDuty.endedAt)))
    ).map((row) => row.name);
    const [updated] = await tx
      .update(appUser)
      .set({
        displayName: fields.displayName,
        email: fields.email,
        orgId: fields.orgId,
        rank: fields.rank,
        billetLabel: fields.billetLabel,
        afsc: fields.afsc,
        primaryDuty: fields.primaryDuty,
        functions: fields.functions,
        supervisorUserId: fields.supervisorUserId,
        leadershipTitle: fields.leadershipTitle,
        availability: fields.availability,
      })
      .where(eq(appUser.id, userId))
      .returning();
    if (!updated) throw new NotFound("persona");
    const duties = await syncDuties(tx, userId, fields.duties);
    await writeAudit(tx, actor, {
      eventType: "personnel.updated",
      entityType: "user",
      entityId: userId,
      payload: { before: snapshot(before, priorDuties), after: snapshot(updated, duties) },
    });
    return updated;
  });
}
