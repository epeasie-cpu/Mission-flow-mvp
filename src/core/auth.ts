import { timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { sealData, unsealData } from "iron-session";
import { auth as authConfig } from "../config/missionflow.config";
import { appUser } from "../db/schema";
import type { Actor, Session } from "./actor";
import { writeAudit } from "./audit";
import type { CoreDb } from "./db";
import { Forbidden, NotFound, ValidationError } from "./errors";
import { listHeldRoles } from "./policy";

export const SESSION_COOKIE = "mf_session";

export function sessionPassword(): string {
  const secret = process.env[authConfig.sessionSecretEnv] ?? "";
  if (secret.length < 32) throw new ValidationError("SESSION_SECRET must be at least 32 characters");
  return secret;
}

export function passcodeMatches(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

async function toSession(db: CoreDb, userId: string, actingRole?: string): Promise<Session> {
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user || !user.isActive) throw new NotFound("persona");
  const heldRoles = await listHeldRoles(db, userId);
  const globalRoles = heldRoles.filter((role) =>
    ["enterprise_participant", "functional_owner", "supervisor", "task_controller", "tasking_authority", "approver", "system_admin"].includes(role),
  );
  const role = actingRole && heldRoles.includes(actingRole) ? actingRole : (heldRoles.find((item) => item !== "enterprise_participant") ?? "enterprise_participant");
  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    actingRole: role,
    globalRoles,
    heldRoles,
  };
}

export async function sealSession(session: Session, secret = sessionPassword()): Promise<string> {
  return sealData(session, { password: secret });
}

export async function readSessionFromSeal(seal: string, secret = sessionPassword()): Promise<Session | null> {
  try {
    const opened = await unsealData<Session>(seal, { password: secret });
    if (!opened?.userId || !opened.actingRole) return null;
    return opened;
  } catch {
    return null;
  }
}

export async function listPersonas(db: CoreDb) {
  const users = await db.select().from(appUser).where(eq(appUser.isActive, true)).orderBy(asc(appUser.displayName));
  const personas = [];
  for (const user of users) {
    personas.push({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      billetLabel: user.billetLabel,
      availability: user.availability,
      heldRoles: await listHeldRoles(db, user.id),
    });
  }
  return personas;
}

export async function signInAsPersona(db: CoreDb, personaId: string, passcode: string): Promise<{ session: Session; seal: string }> {
  const expected = process.env[authConfig.demoPasscodeEnv] ?? "";
  const [user] = await db.select().from(appUser).where(eq(appUser.id, personaId)).limit(1);
  if (!user) {
    await writeAudit(db, { type: "system" }, {
      eventType: "auth.access_denied",
      entityType: "auth",
      payload: { action: "auth.sign_in", persona_id: personaId },
    });
    throw new NotFound("persona");
  }
  if (!expected || !passcodeMatches(passcode, expected)) {
    await writeAudit(db, { type: "user", userId: user.id, actingRole: "enterprise_participant" }, {
      eventType: "auth.access_denied",
      entityType: "auth",
      payload: { action: "auth.sign_in" },
    });
    throw new Forbidden("passcode");
  }
  const session = await toSession(db, user.id);
  await writeAudit(db, { type: "user", userId: user.id, actingRole: session.actingRole }, {
    eventType: "auth.signed_in",
    entityType: "user",
    entityId: user.id,
    payload: { acting_role: session.actingRole },
  });
  return { session, seal: await sealSession(session) };
}

export async function switchActingRole(db: CoreDb, session: Session, role: string): Promise<{ session: Session; seal: string }> {
  const held = await listHeldRoles(db, session.userId);
  if (!held.includes(role)) {
    await writeAudit(db, { type: "user", userId: session.userId, actingRole: session.actingRole }, {
      eventType: "auth.access_denied",
      entityType: "auth",
      payload: { action: "auth.switch_role", requested_role: role },
    });
    throw new Forbidden("acting role");
  }
  const next = await toSession(db, session.userId, role);
  await writeAudit(db, { type: "user", userId: session.userId, actingRole: role }, {
    eventType: "auth.acting_role_switched",
    entityType: "user",
    entityId: session.userId,
    payload: { before: session.actingRole, after: role },
  });
  return { session: next, seal: await sealSession(next) };
}

export async function loadPersona(
  db: CoreDb,
  userId: string,
  actingRole?: string,
): Promise<{ session: Session; billetLabel: string } | null> {
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user || !user.isActive) return null;
  return { session: await toSession(db, userId, actingRole), billetLabel: user.billetLabel ?? "" };
}

export async function signOut(db: CoreDb, session: Session): Promise<void> {
  await writeAudit(db, { type: "user", userId: session.userId, actingRole: session.actingRole }, {
    eventType: "auth.signed_out",
    entityType: "user",
    entityId: session.userId,
    payload: {},
  });
}

export function actorFromSession(session: Session): Actor {
  return { type: "user", userId: session.userId, actingRole: session.actingRole };
}
