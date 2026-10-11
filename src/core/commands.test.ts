import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DISPOSITION_TYPES, type DispositionType, type TaskerState } from "../config/missionflow.config";
import {
  aiArtifact,
  appUser,
  auditEvent,
  document,
  documentVersion,
  escalation,
  gate,
  org,
  position,
  roleGrant,
  suspensePlan,
  suspenseResolution,
  tasker,
  taskerAssignment,
} from "../db/schema";
import { setGatewayClientForTests } from "./ai";
import { generate, verify as verifyArtifact } from "./ai";
import { clearSubscribers, dispatchOutbox, subscribe, verifyChain, writeAudit } from "./audit";
import { signInAsPersona, switchActingRole } from "./auth";
import { createVersion, lockFinal, uploadDocument } from "./docs";
import { Forbidden, InvalidTransition, NotFound, ValidationError } from "./errors";
import { addGate, autoCloseOverdue, decideGate, elevate, openGates, reopenCoordination, routeToApproval } from "./gates";
import {
  accept,
  acknowledge,
  adjudicateTriage,
  applyDisposition,
  changeSuspenseAfterRelease,
  changeTransmitFlag,
  claimNoEquity,
  createDraft,
  getTasker,
  raiseEscalation,
  reassign,
  release,
  requestClarification,
  resolveEscalation,
  resolveSuspenseConflict,
  setExternalSuspense,
  sign,
  submitForRelease,
  timeToCorrectAo,
} from "./lifecycle";
import { seedDemo } from "./seed";
import type { CoreDb } from "./db";
import { createHarness, resetDemo, type Harness } from "../test/harness";

process.env.DEMO_PASSCODE = "demo-pass-test";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.MF_AI_COMMERCIAL_ENABLED = "false";

const NOW = new Date("2026-10-11T16:00:00.000Z");
const FAR = "2027-06-30";

type Ids = {
  wing: string;
  squadron: string;
  center: string;
  naf: string;
  originator: string;
  centerOrigin: string;
  nafOrigin: string;
  ta: string;
  ao: string;
  alt: string;
  apo: string;
  approver: string;
  coordinator: string;
  supervisor: string;
  fo: string;
  admin: string;
  tc: string;
  other: string;
  aoPos: string;
  approverPos: string;
  entry: string;
};

let harness: Harness;
let ids: Ids;
let placeSeq = 0;

async function foundation(db: CoreDb): Promise<Ids> {
  const wing = randomUUID();
  const center = randomUUID();
  const naf = randomUUID();
  const squadron = randomUUID();
  await db.insert(org).values([
    { id: center, name: "Example Center", shortCode: `EC${center.slice(0, 4)}`, echelon: "center" },
    { id: naf, name: "Example Numbered Force", shortCode: `NF${naf.slice(0, 4)}`, echelon: "naf" },
    { id: wing, name: "Sample Wing", shortCode: `SW${wing.slice(0, 4)}`, echelon: "wing", parentOrgId: center, missionCodes: ["LOG-RDY"] },
    { id: squadron, name: "Sample Logistics Readiness Squadron", shortCode: `LS${squadron.slice(0, 4)}`, echelon: "squadron", parentOrgId: wing, missionCodes: ["LOG-RDY"] },
  ]);
  const people = {
    originator: ["Avery Sample", "avery.sample@example.test", squadron, "Task originator"],
    centerOrigin: ["Quinn Example", "quinn.example@example.test", center, "Task originator"],
    nafOrigin: ["Blake Placeholder", "blake.placeholder@example.test", naf, "Task originator"],
    ta: ["Jordan Placeholder", "jordan.placeholder@example.test", wing, "Tasking authority"],
    ao: ["Taylor Standin", "taylor.standin@example.test", squadron, "Awards program manager"],
    alt: ["Casey Sample", "casey.sample@example.test", squadron, "Awards alternate"],
    apo: ["Riley Example", "riley.example@example.test", squadron, "Readiness flight chief"],
    approver: ["Hayden Example", "hayden.example@example.test", wing, "Wing commander (synthetic)"],
    coordinator: ["Reese Sample", "reese.sample@example.test", wing, "Protocol coordinator"],
    supervisor: ["Jamie Sample", "jamie.sample@example.test", squadron, "LRS ops officer"],
    fo: ["Parker Example", "parker.example@example.test", wing, "Functional owner"],
    admin: ["Elliot Sample", "elliot.sample@example.test", wing, "System administrator"],
    tc: ["Rowan Placeholder", "rowan.placeholder@example.test", wing, "Task controller"],
    other: ["Finley Placeholder", "finley.placeholder@example.test", squadron, "Staff contributor"],
  } as const;
  const userIds = Object.fromEntries(Object.keys(people).map((key) => [key, randomUUID()])) as Record<keyof typeof people, string>;
  await db.insert(appUser).values(
    Object.entries(people).map(([key, value]) => ({
      id: userIds[key as keyof typeof people],
      displayName: value[0],
      email: value[1],
      orgId: value[2],
      billetLabel: value[3],
    })),
  );
  const aoPos = randomUUID();
  const approverPos = randomUUID();
  const apoPos = randomUUID();
  const supPos = randomUUID();
  const coordPos = randomUUID();
  await db.insert(position).values([
    { id: aoPos, title: "Awards program manager", orgId: squadron, incumbentUserId: userIds.ao, alternateUserId: userIds.alt },
    { id: approverPos, title: "Wing commander (synthetic)", orgId: wing, incumbentUserId: userIds.approver },
    { id: apoPos, title: "Readiness flight chief", orgId: squadron, incumbentUserId: userIds.apo },
    { id: supPos, title: "LRS ops officer", orgId: squadron, incumbentUserId: userIds.supervisor },
    { id: coordPos, title: "Protocol", orgId: wing, incumbentUserId: userIds.coordinator },
  ]);
  await db.insert(roleGrant).values([
    { userId: userIds.ta, role: "tasking_authority", grantedBy: userIds.admin },
    { userId: userIds.fo, role: "functional_owner", grantedBy: userIds.admin },
    { userId: userIds.supervisor, role: "supervisor", scopeOrgId: squadron, grantedBy: userIds.admin },
    { userId: userIds.approver, role: "approver", scopeOrgId: wing, grantedBy: userIds.admin },
    { userId: userIds.tc, role: "task_controller", grantedBy: userIds.admin },
    { userId: userIds.admin, role: "system_admin", grantedBy: userIds.admin },
  ]);
  const entry = randomUUID();
  const { registryEntry } = await import("../db/schema");
  await db.insert(registryEntry).values({
    id: entry,
    responsibilityId: `LOG-${entry.slice(0, 8)}`,
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    orgScope: { echelons: ["squadron", "wing"], org_ids: [wing, squadron] },
    accountablePositionId: apoPos,
    responsiblePositionId: aoPos,
    designatedAlternateUserId: userIds.alt,
    supervisoryPositionId: supPos,
    mandatoryCoordination: [{ office: "Protocol", position_id: coordPos, default_justification: "Protocol reviews the fictional citation." }],
    designatedApproverPositionId: approverPos,
    baselineTimelineProfile: [
      { stage: "ao_drafting", business_days: 10 },
      { stage: "coordination", business_days: 4 },
      { stage: "approval", business_days: 3 },
    ],
    applicabilityCriteria: { mission_codes_any: ["LOG-RDY"] },
    taskCategories: ["awards_package"],
    keywords: ["award", "nominee", "readiness"],
    status: "active",
    lastValidatedAt: NOW,
    validatedBy: userIds.fo,
    functionalOwnerUserId: userIds.fo,
  });
  return { wing, squadron, center, naf, ...userIds, aoPos, approverPos, entry };
}

const user = (userId: string, actingRole: string) => ({ type: "user" as const, userId, actingRole });

describe("core commands", () => {
  beforeAll(async () => {
    harness = await createHarness();
  }, 60_000);

  beforeEach(async () => {
    clearSubscribers();
    setGatewayClientForTests(null);
    placeSeq = 0;
    await resetDemo(harness.client);
    ids = await foundation(harness.db);
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("rolls back the domain change and the audit together, then verifies, detects tamper, and bumps the epoch", async () => {
    const { db, client } = harness;
    const drafted = await createDraft(db, user(ids.originator, "originator"), draftInput("Rollback"));
    await expect(
      db.transaction(async (tx) => {
        await writeAudit(tx as unknown as CoreDb, user(ids.originator, "originator"), {
          eventType: "tasker.draft_updated",
          entityType: "tasker",
          entityId: drafted.id,
          taskerId: drafted.id,
          payload: { probe: true },
        });
        await (tx as unknown as CoreDb).update(tasker).set({ title: "changed" }).where(eq(tasker.id, drafted.id));
        throw new Error("forced");
      }),
    ).rejects.toThrow("forced");
    const [fresh] = await db.select().from(tasker).where(eq(tasker.id, drafted.id));
    expect(fresh?.title).toBe(drafted.title);
    const probe = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "tasker.draft_updated"));
    expect(probe).toHaveLength(0);
    expect(await verifyChain(db)).toEqual({ ok: true });

    await client.exec("alter table audit_event disable trigger user");
    await client.exec(`update audit_event set payload = '{"tampered":true}'::jsonb where seq = (select min(seq) from audit_event)`);
    await client.exec("alter table audit_event enable trigger user");
    const broken = await verifyChain(db);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.brokenAtSeq).toBeGreaterThan(0);

    const before = await db.execute<{ epoch: number }>(sql`select current_epoch as epoch from audit_chain_meta where id = 1`);
    await resetDemo(client);
    const after = await db.execute<{ epoch: number }>(sql`select current_epoch as epoch from audit_chain_meta where id = 1`);
    expect(Number(after.rows[0]?.epoch)).toBe(Number(before.rows[0]?.epoch) + 1);
    const chain = await verifyChain(db);
    expect(chain).toEqual({ ok: true });
    ids = await foundation(db);
  });

  it("delivers an outbox event once", async () => {
    const drafted = await createDraft(harness.db, user(ids.originator, "originator"), draftInput("Notify"));
    const submitted = await submitForRelease(harness.db, user(ids.originator, "originator"), drafted.id, NOW);
    const released = await release(harness.db, user(ids.ta, "tasking_authority"), submitted.tasker.id, { now: NOW });
    const seen: string[] = [];
    subscribe("tasker.released", "test.dayOne", async (event) => {
      seen.push(event.id);
    });
    await dispatchOutbox(harness.db);
    await dispatchOutbox(harness.db);
    expect(seen).toHaveLength(1);
    expect(released.state).toBe("ASSIGNED");
  });

  it("signs in with the shared passcode and refuses a role the persona does not hold", async () => {
    const { db } = harness;
    await expect(signInAsPersona(db, ids.originator, "nope")).rejects.toBeInstanceOf(Forbidden);
    const signed = await signInAsPersona(db, ids.ta, "demo-pass-test");
    expect(signed.seal.length).toBeGreaterThan(20);
    expect(signed.session.heldRoles).toContain("tasking_authority");
    const switched = await switchActingRole(db, signed.session, "enterprise_participant");
    expect(switched.session.actingRole).toBe("enterprise_participant");
    await expect(switchActingRole(db, signed.session, "system_admin")).rejects.toBeInstanceOf(Forbidden);
    const denied = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "auth.access_denied"));
    expect(denied.length).toBeGreaterThan(0);
  });

  it("hides taskers from people who are not entitled and from the system admin", async () => {
    const drafted = await createDraft(harness.db, user(ids.originator, "originator"), draftInput("Hidden"));
    await expect(getTasker(harness.db, drafted.id, user(ids.other, "enterprise_participant"))).rejects.toBeInstanceOf(NotFound);
    await expect(getTasker(harness.db, drafted.id, user(ids.admin, "system_admin"))).rejects.toBeInstanceOf(NotFound);
    await expect(applyDisposition(harness.db, user(ids.admin, "system_admin"), drafted.id, "cancelled_obe", { rationale: "no" })).rejects.toBeInstanceOf(Forbidden);
    const metadata = await (async () => {
      const submitted = await submitForRelease(harness.db, user(ids.originator, "originator"), drafted.id, NOW);
      await release(harness.db, user(ids.ta, "tasking_authority"), submitted.tasker.id, { now: NOW });
      return getTasker(harness.db, drafted.id, user(ids.tc, "task_controller"));
    })();
    expect(metadata.contentRedacted).toBe(true);
    expect(metadata.requirement).toBe("");
  });

  it("runs the eight dispositions from the states that allow them and rejects the rest", async () => {
    const states: TaskerState[] = ["DRAFT", "PENDING_RELEASE", "SUSPENSE_CONFLICT", "TRIAGE", "ASSIGNED", "CLARIFICATION", "IN_WORK", "IN_COORDINATION", "AWAITING_APPROVAL", "CLOSED"];
    const allowed = new Set<string>([
      "completed:AWAITING_APPROVAL",
      "submitted:AWAITING_APPROVAL",
      "no_equity_validated:TRIAGE",
      "reassigned:ASSIGNED",
      "reassigned:CLARIFICATION",
      "reassigned:IN_WORK",
      "reassigned:IN_COORDINATION",
      "reassigned:AWAITING_APPROVAL",
      "reassigned:TRIAGE",
      "cancelled_obe:DRAFT",
      "cancelled_obe:PENDING_RELEASE",
      "cancelled_obe:SUSPENSE_CONFLICT",
      "cancelled_obe:TRIAGE",
      "cancelled_obe:ASSIGNED",
      "cancelled_obe:CLARIFICATION",
      "cancelled_obe:IN_WORK",
      "cancelled_obe:IN_COORDINATION",
      "cancelled_obe:AWAITING_APPROVAL",
      "returned_for_rework:IN_COORDINATION",
      "returned_for_rework:AWAITING_APPROVAL",
    ]);
    for (const type of DISPOSITION_TYPES) {
      for (const state of states) {
        if (type === "concurred" || type === "nonconcurred") {
          if (state === "CLOSED") continue;
          allowed.add(`${type}:${state}`);
        }
      }
    }
    for (const type of DISPOSITION_TYPES) {
      for (const state of states) {
        const key = `${type}:${state}`;
        const transmit = type === "submitted";
        const releasedTriage = type === "reassigned" && state === "TRIAGE";
        const id = await place(harness.db, state, { transmit, released: releasedTriage ? true : undefined, withGate: type === "concurred" || type === "nonconcurred" });
        const actor = actorFor(type);
        const opts = {
          rationale: "Because the fictional package moved.",
          redirectTo: ids.alt,
          gateId:
            type === "concurred" || type === "nonconcurred"
              ? state === "CLOSED"
                ? (await harness.db.select({ id: gate.id }).from(gate).where(eq(gate.taskerId, id)))[0]?.id
                : await openGateId(harness.db, id)
              : undefined,
        };
        if (allowed.has(key)) {
          const updated = await applyDisposition(harness.db, actor, id, type, opts);
          if (type === "concurred") expect(updated.state, key).toBe(state);
          else if (type === "nonconcurred") expect(updated.state, key).toBe(state === "IN_COORDINATION" ? "IN_WORK" : state);
          else if (type === "reassigned") expect(updated.state, key).toBe("ASSIGNED");
          else if (type === "returned_for_rework") {
            expect(updated.state, key).toBe("IN_WORK");
            expect(updated.reworkCount).toBe(1);
          } else expect(updated.state, key).toBe("CLOSED");
          if (updated.state === "CLOSED") expect(updated.closedDispositionType).toBe(type);
        } else {
          await expect(applyDisposition(harness.db, actor, id, type, opts), key).rejects.toThrow();
        }
      }
    }
  }, 120_000);

  it("keeps gates across reassignment, notes a nonconcur that does not move state, and auto-closes gates", async () => {
    const { db } = harness;
    const id = await place(db, "AWAITING_APPROVAL", { withGate: true, gateStatus: "concurred" });
    const before = await db.select().from(gate).where(eq(gate.taskerId, id));
    await reassign(db, user(ids.supervisor, "supervisor"), id, ids.alt, "Coverage for the fictional package.");
    const after = await db.select().from(gate).where(eq(gate.taskerId, id));
    expect(after.map((item) => [item.status, item.round])).toEqual(before.map((item) => [item.status, item.round]));
    const moved = await db.select().from(tasker).where(eq(tasker.id, id));
    expect(moved[0]?.state).toBe("ASSIGNED");
    expect(moved[0]?.acceptedAt).toBeNull();
    await expect(routeToApproval(db, user(ids.alt, "ao_primary"), id)).rejects.toBeInstanceOf(InvalidTransition);
    await accept(db, user(ids.alt, "ao_primary"), id, new Date("2026-10-12T15:00:00.000Z"));
    const routed = await routeToApproval(db, user(ids.alt, "ao_primary"), id);
    expect(routed.state).toBe("AWAITING_APPROVAL");

    const noted = await place(db, "ASSIGNED", { withGate: true });
    const gateId = await openGateId(db, noted);
    await applyDisposition(db, user(ids.coordinator, "coordinator"), noted, "nonconcurred", { rationale: "Sample objection.", gateId });
    const notedRow = await db.select().from(tasker).where(eq(tasker.id, noted));
    expect(notedRow[0]?.state).toBe("ASSIGNED");
    const notes = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "tasker.nonconcurrence_noted"));
    expect(notes.length).toBeGreaterThan(0);

    const closing = await place(db, "IN_COORDINATION", { withGate: true });
    await applyDisposition(db, user(ids.ta, "tasking_authority"), closing, "cancelled_obe", { rationale: "Overtaken by a sample event." });
    const stillOpen = await db.select().from(gate).where(eq(gate.taskerId, closing));
    expect(stillOpen.every((item) => item.status === "auto_closed")).toBe(true);
    const auto = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "gate.auto_closed"));
    expect(auto.some((item) => item.actorType === "system")).toBe(true);
  });

  it("records both AO acceptance times and joins a second escalation", async () => {
    const { db } = harness;
    const id = await place(db, "ASSIGNED");
    await accept(db, user(ids.ao, "ao_primary"), id, new Date("2026-10-11T18:00:00.000Z"));
    await reassign(db, user(ids.supervisor, "supervisor"), id, ids.alt, "Handing the fictional package over.");
    await accept(db, user(ids.alt, "ao_primary"), id, new Date("2026-10-12T18:00:00.000Z"));
    const rows = await db.select().from(taskerAssignment).where(eq(taskerAssignment.taskerId, id));
    const primaries = rows.filter((item) => item.role === "ao_primary");
    expect(primaries).toHaveLength(2);
    expect(primaries.every((item) => item.acceptedAt)).toBe(true);
    const [current] = await db.select().from(tasker).where(eq(tasker.id, id));
    expect(current?.acceptedAt?.toISOString()).toBe("2026-10-12T18:00:00.000Z");
    expect(timeToCorrectAo(current!)).toBeGreaterThan(0);

    const clarified = await place(db, "CLARIFICATION", { released: true });
    const first = await raiseEscalation(db, user(ids.ao, "ao_primary"), clarified, "Need a sample reviewer.");
    expect(first.tasker.state).toBe("CLARIFICATION");
    const second = await raiseEscalation(db, user(ids.supervisor, "supervisor"), clarified, "Joining the same sample issue.");
    expect(second.joined).toBe(true);
    const open = await db.select().from(escalation).where(eq(escalation.taskerId, clarified));
    expect(open).toHaveLength(1);
    await expect(resolveEscalation(db, user(ids.ao, "ao_primary"), first.escalation.id, "no")).rejects.toBeInstanceOf(Forbidden);
    await resolveEscalation(db, user(ids.supervisor, "supervisor"), first.escalation.id, "Reviewer added in the sample.");
  });

  it("blocks release on a suspense conflict until b–e or a new date, and warns under 35 percent", async () => {
    const { db } = harness;
    const conflicted = await createDraft(db, user(ids.originator, "originator"), draftInput("Conflict", "2026-10-23"));
    const submitted = await submitForRelease(db, user(ids.originator, "originator"), conflicted.id, NOW);
    expect(submitted.tasker.state).toBe("SUSPENSE_CONFLICT");
    expect(submitted.plan.warning).toBeNull();
    const held = await resolveSuspenseConflict(db, user(ids.ta, "tasking_authority"), conflicted.id, "a", "Asking for a sample extension.", NOW);
    expect(held.state).toBe("SUSPENSE_CONFLICT");
    await expect(release(db, user(ids.ta, "tasking_authority"), conflicted.id, { now: NOW })).rejects.toThrow();
    const cleared = await resolveSuspenseConflict(db, user(ids.ta, "tasking_authority"), conflicted.id, "c", "Marking the sample flash.", NOW);
    expect(cleared.state).toBe("PENDING_RELEASE");
    expect(cleared.priority).toBe("flash_urgent");
    const resolutions = await db.select().from(suspenseResolution).where(eq(suspenseResolution.taskerId, conflicted.id));
    expect(resolutions).toHaveLength(2);
    await release(db, user(ids.ta, "tasking_authority"), conflicted.id, { now: NOW });

    const dated = await createDraft(db, user(ids.originator, "originator"), draftInput("New date", "2026-10-20"));
    await submitForRelease(db, user(ids.originator, "originator"), dated.id, NOW);
    const replaced = await setExternalSuspense(db, user(ids.ta, "tasking_authority"), dated.id, FAR, NOW);
    expect(replaced.state).toBe("PENDING_RELEASE");

    await expect(
      changeSuspenseAfterRelease(db, { type: "ai" }, conflicted.id, FAR, NOW),
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it("signs from the transmit flag and rejects an approver override", async () => {
    const { db } = harness;
    const internal = await place(db, "AWAITING_APPROVAL", { transmit: false });
    await expect(applyDisposition(db, user(ids.approver, "approver"), internal, "submitted", { rationale: "no" })).rejects.toBeInstanceOf(ValidationError);
    const completed = await sign(db, user(ids.approver, "approver"), internal);
    expect(completed.closedDispositionType).toBe("completed");
    expect(completed.transmitToHigherHq).toBe(false);

    const upward = await place(db, "AWAITING_APPROVAL", { transmit: true });
    const submitted = await sign(db, user(ids.approver, "approver"), upward);
    expect(submitted.closedDispositionType).toBe("submitted");
    await expect(changeTransmitFlag(db, user(ids.originator, "originator"), upward, false)).rejects.toBeInstanceOf(Forbidden);

    const live = await place(db, "ASSIGNED", { transmit: false });
    const changed = await changeTransmitFlag(db, user(ids.ta, "tasking_authority"), live, true);
    expect(changed.transmitToHigherHq).toBe(true);
    const audits = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "tasker.transmit_flag_changed"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("defaults transmission from echelon rank", async () => {
    const { db } = harness;
    const centerDraft = await createDraft(db, user(ids.centerOrigin, "originator"), {
      ...draftInput("Center package"),
      targetOrgId: ids.squadron,
    });
    const centerSubmitted = await submitForRelease(db, user(ids.centerOrigin, "originator"), centerDraft.id, NOW);
    const centerReleased = await release(db, user(ids.ta, "tasking_authority"), centerSubmitted.tasker.id, { now: NOW });
    expect(centerReleased.transmitToHigherHq).toBe(true);

    const nafDraft = await createDraft(db, user(ids.nafOrigin, "originator"), draftInput("Equal rank"));
    await db.update(position).set({ orgId: ids.naf }).where(eq(position.id, ids.approverPos));
    const nafSubmitted = await submitForRelease(db, user(ids.nafOrigin, "originator"), nafDraft.id, NOW);
    expect(nafSubmitted.tasker.state).toBe("PENDING_RELEASE");
    const nafReleased = await release(db, user(ids.ta, "tasking_authority"), nafDraft.id, { now: NOW });
    expect(nafReleased.transmitToHigherHq).toBe(false);
  });

  it("adjudicates pre-release triage without a disposition and post-dispatch triage three ways", async () => {
    const { db } = harness;
    const unmatched = await createDraft(db, user(ids.originator, "originator"), {
      ...draftInput("No match"),
      missionFunction: "no such function",
    });
    const triaged = await submitForRelease(db, user(ids.originator, "originator"), unmatched.id, NOW);
    expect(triaged.tasker.state).toBe("TRIAGE");
    const picked = await adjudicateTriage(db, user(ids.fo, "functional_owner"), unmatched.id, "entry_picked", { entryId: ids.entry });
    expect(picked.state).toBe("PENDING_RELEASE");
    const dispositions = await db.select().from(suspensePlan);
    const disp = await import("../db/schema").then((schema) => db.select().from(schema.disposition).where(eq(schema.disposition.taskerId, unmatched.id)));
    expect(disp).toHaveLength(0);
    expect(dispositions.length).toBeGreaterThan(0);

    const claimed = await place(db, "ASSIGNED");
    const inTriage = await claimNoEquity(db, user(ids.ao, "ao_primary"), claimed, "No sample equity.", NOW);
    expect(inTriage.state).toBe("TRIAGE");
    const confirmed = await adjudicateTriage(db, user(ids.fo, "functional_owner"), claimed, "equity_confirmed", { rationale: "Equity stands." });
    expect(confirmed.state).toBe("ASSIGNED");
    const confirmedDisp = await import("../db/schema").then((schema) => db.select().from(schema.disposition).where(eq(schema.disposition.taskerId, claimed)));
    expect(confirmedDisp).toHaveLength(0);
  });

  it("elevates a nonconcurrence and still lets another gate be decided", async () => {
    const { db } = harness;
    const id = await place(db, "IN_WORK", { withGate: true });
    const first = await openGateId(db, id);
    await db.insert(gate).values({
      taskerId: id,
      kind: "coordination",
      sequence: 2,
      officeLabel: "Command Section",
      assigneeUserId: ids.coordinator,
      source: "ao_requested",
      justification: "A second fictional office.",
      dueDate: FAR,
      status: "open",
    });
    await applyDisposition(db, user(ids.coordinator, "coordinator"), id, "nonconcurred", { rationale: "Sample nonconcur.", gateId: first });
    const others = await db.select().from(gate).where(eq(gate.taskerId, id));
    const second = others.find((item) => item.officeLabel === "Command Section");
    expect(second?.status).toBe("open");
    await applyDisposition(db, user(ids.coordinator, "coordinator"), id, "concurred", { gateId: second!.id });
    await expect(routeToApproval(db, user(ids.ao, "ao_primary"), id)).rejects.toBeInstanceOf(InvalidTransition);
    await expect(elevate(db, user(ids.coordinator, "coordinator"), id, "Forwarding the sample objection.")).rejects.toBeInstanceOf(Forbidden);
    const elevated = await elevate(db, user(ids.ao, "ao_primary"), id, "Forwarding the sample objection.");
    expect(elevated.state).toBe("AWAITING_APPROVAL");
    expect(elevated.elevatedNonconcurrence?.gate_ids).toContain(first);
    const event = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "tasker.elevated_with_nonconcurrence"));
    expect(event.length).toBeGreaterThan(0);
  });

  it("freezes a package version, auto-closes an overdue non-blocking gate, and enforces the final enclave", async () => {
    const { db } = harness;
    const id = await place(db, "IN_WORK");
    const uploaded = await uploadDocument(db, user(ids.ao, "ao_primary"), id, {
      enclave: "draft",
      title: "Citation",
      bodyMd: "Fictional bullet.",
    });
    await addGate(db, user(ids.ao, "ao_primary"), id, {
      kind: "coordination",
      officeLabel: "Protocol",
      justification: "Protocol reviews the fictional citation.",
      dueDate: FAR,
      assigneeUserId: ids.coordinator,
    });
    await openGates(db, user(ids.ao, "ao_primary"), id);
    const [frozen] = await db.select().from(gate).where(eq(gate.taskerId, id));
    expect(frozen?.packageVersionId).toBe(uploaded.version.id);
    await createVersion(db, user(ids.ao, "ao_primary"), uploaded.document.id, { bodyMd: "A later fictional bullet." });
    const [still] = await db.select().from(gate).where(eq(gate.id, frozen!.id));
    expect(still?.packageVersionId).toBe(uploaded.version.id);

    await db.insert(gate).values({
      taskerId: id,
      kind: "coordination",
      sequence: 9,
      officeLabel: "Awareness copy",
      assigneeUserId: ids.coordinator,
      source: "ao_requested",
      justification: "Non-blocking sample.",
      blocking: false,
      dueDate: "2026-10-01",
      status: "open",
    });
    const closed = await autoCloseOverdue(db, NOW);
    expect(closed.length).toBe(1);

    const { artifact } = await generate(db, user(ids.ao, "ao_primary"), id, "first_draft");
    expect(artifact.content.startsWith(artifact.stamp)).toBe(true);
    expect(artifact.content.endsWith(artifact.stamp)).toBe(true);
    expect(artifact.provider).toBe("template");
    expect(artifact.isAccredited).toBe(false);
    await expect(db.update(aiArtifact).set({ content: "tamper" }).where(eq(aiArtifact.id, artifact.id))).rejects.toThrow();

    const finalDoc = await uploadDocument(db, user(ids.approver, "approver"), id, {
      enclave: "final",
      title: "Final",
      bodyMd: "Human final.",
    });
    await expect(
      createVersion(db, user(ids.ao, "ao_primary"), finalDoc.document.id, {
        bodyMd: `${artifact.stamp}\nbody\n${artifact.stamp}`,
        authorType: "ai",
        aiArtifactId: artifact.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createVersion(db, user(ids.approver, "approver"), finalDoc.document.id, {
        bodyMd: "Derived.",
        authorType: "human",
        derivedFromVersionId: (
          await createVersion(db, user(ids.ao, "ao_primary"), uploaded.document.id, {
            bodyMd: `${artifact.stamp}\nbody\n${artifact.stamp}`,
            authorType: "ai",
            aiArtifactId: artifact.id,
          })
        ).id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await verifyArtifact(db, user(ids.ao, "ao_primary"), artifact.id, "verified", "Looks like sample text.");
    const derived = await createVersion(db, user(ids.approver, "approver"), finalDoc.document.id, {
      bodyMd: "Human words after verification.",
      authorType: "human",
      derivedFromVersionId: (await db.select().from(documentVersion).where(eq(documentVersion.aiArtifactId, artifact.id)))[0]!.id,
    });
    expect(derived.authorType).toBe("human");
    await lockFinal(db, user(ids.approver, "approver"), finalDoc.document.id);
    const [locked] = await db.select().from(document).where(eq(document.id, finalDoc.document.id));
    expect(locked?.locked).toBe(true);
  });

  it("falls back to the template when the mocked gateway fails or the cap is hit", async () => {
    const { db } = harness;
    const id = await place(db, "IN_WORK");
    const env = {
      MF_AI_COMMERCIAL_ENABLED: "true",
      MF_DEPLOYMENT: "public-demo",
      VERCEL_ENV: "production",
      MF_AI_GATEWAY_MODEL: "openai/gpt-5.4-nano",
      MF_AI_GATEWAY_FALLBACK_MODELS: "anthropic/claude-haiku-4.5",
    };
    setGatewayClientForTests(async () => {
      throw new Error("down");
    });
    const failed = await generate(db, user(ids.ao, "ao_primary"), id, "first_draft", [], { env, now: NOW });
    expect(failed.artifact.provider).toBe("template");
    expect(failed.notice).toBeTruthy();

    setGatewayClientForTests(async (request) => ({ model: request.model, text: "Fictional gateway draft." }));
    const ok = await generate(db, user(ids.ao, "ao_primary"), id, "first_draft", [], { env, now: NOW });
    expect(ok.artifact.provider).toBe("vercel_ai_gateway");
    expect(ok.artifact.model).toBe("openai/gpt-5.4-nano");
    expect(ok.artifact.demoLabel ?? "").toMatch(/not accredited/i);
    expect(ok.artifact.isAccredited).toBe(false);

    for (let n = 0; n < 9; n += 1) {
      await generate(db, user(ids.ao, "ao_primary"), id, "template", [], { env, now: NOW });
    }
    const capped = await generate(db, user(ids.ao, "ao_primary"), id, "template", [], { env, now: NOW });
    expect(capped.artifact.provider).toBe("template");
    expect(capped.notice).toMatch(/10 drafts/);
  });

  it("rejects an AI actor on release, gates, disposition, assignment, and escalation", async () => {
    const { db } = harness;
    const drafted = await createDraft(db, user(ids.originator, "originator"), draftInput("AI blocked"));
    const submitted = await submitForRelease(db, user(ids.originator, "originator"), drafted.id, NOW);
    const ai = { type: "ai" as const, requestedBy: ids.ao };
    await expect(release(db, ai, submitted.tasker.id)).rejects.toBeInstanceOf(Forbidden);
    const id = await place(db, "IN_WORK");
    await expect(addGate(db, ai, id, { kind: "coordination", officeLabel: "X", justification: "no", dueDate: FAR })).rejects.toBeInstanceOf(Forbidden);
    await expect(applyDisposition(db, ai, id, "cancelled_obe", { rationale: "no" })).rejects.toBeInstanceOf(Forbidden);
    await expect(reassign(db, ai, id, ids.alt, "no")).rejects.toBeInstanceOf(Forbidden);
    await expect(raiseEscalation(db, ai, id, "no")).rejects.toBeInstanceOf(Forbidden);
    await expect(resolveEscalation(db, ai, randomUUID(), "no")).rejects.toThrow();
  });

  it("reopens only nonconcurred gates unless the AO selects a concurred one", async () => {
    const { db } = harness;
    const id = await place(db, "IN_COORDINATION", { withGate: true });
    const gateId = await openGateId(db, id);
    await db.insert(gate).values({
      taskerId: id,
      kind: "coordination",
      sequence: 3,
      officeLabel: "Kept",
      assigneeUserId: ids.coordinator,
      source: "ao_requested",
      justification: "Already concurred.",
      dueDate: FAR,
      status: "concurred",
      round: 1,
    });
    await applyDisposition(db, user(ids.coordinator, "coordinator"), id, "nonconcurred", { rationale: "Sample.", gateId });
    const reopened = await reopenCoordination(db, user(ids.ao, "ao_primary"), id);
    expect(reopened.state).toBe("IN_COORDINATION");
    const rows = await db.select().from(gate).where(eq(gate.taskerId, id));
    expect(rows.find((item) => item.id === gateId)?.round).toBe(2);
    expect(rows.find((item) => item.officeLabel === "Kept")?.round).toBe(1);
    expect(rows.find((item) => item.officeLabel === "Kept")?.status).toBe("concurred");
  });

  it("acknowledges without moving state and records the first AO view", async () => {
    const { db } = harness;
    const id = await place(db, "ASSIGNED");
    const acked = await acknowledge(db, user(ids.ao, "ao_primary"), id);
    expect(acked.state).toBe("ASSIGNED");
    const viewed = await getTasker(db, id, user(ids.ao, "ao_primary"));
    expect(viewed.firstViewedByAoAt).toBeTruthy();
    await getTasker(db, id, user(ids.ao, "ao_primary"));
    const views = await db.select().from(auditEvent).where(eq(auditEvent.eventType, "tasker.first_viewed_by_ao"));
    expect(views).toHaveLength(1);
  });

  it("seeds the fictional awards pilot through commands and can run twice", async () => {
    const first = await seedDemo(harness.db, {
      now: NOW,
      reset: true,
      execReset: () => resetDemo(harness.client),
    });
    expect(first.alreadySeeded).toBe(false);
    const byTitle = Object.fromEntries(first.taskers.map((row) => [row.title.replace("[seed] ", ""), row.state]));
    expect(byTitle["Fresh quarterly award"]).toBe("ASSIGNED");
    expect(byTitle["Suspense conflict award"]).toBe("SUSPENSE_CONFLICT");
    expect(byTitle["Coordination with a nonconcur"]).toBe("IN_WORK");
    expect(byTitle["Returned for rework"]).toBe("IN_WORK");
    expect(byTitle["Wing-internal quarterly award"]).toBe("CLOSED");
    expect(byTitle["EXCOM annual award"]).toBe("CLOSED");
    expect(byTitle["Clarification with an open escalation"]).toBe("CLARIFICATION");
    expect(byTitle["Unmatched triage item"]).toBe("TRIAGE");
    expect(byTitle["Cancelled requirement"]).toBe("CLOSED");
    const second = await seedDemo(harness.db, { now: NOW });
    expect(second.alreadySeeded).toBe(true);
    expect(second.taskers).toHaveLength(first.taskers.length);
  }, 120_000);
});

function draftInput(title: string, suspense = FAR) {
  return {
    title,
    category: "awards_package" as const,
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    targetOrgId: ids.squadron,
    requirement: "Fictional award worksheet for a fictional nominee.",
    deliverableFormat: "AWARD-1206-BBP",
    externalSuspense: suspense,
    now: NOW,
  };
}

function actorFor(type: DispositionType) {
  if (type === "completed" || type === "submitted" || type === "returned_for_rework") return user(ids.approver, "approver");
  if (type === "concurred" || type === "nonconcurred") return user(ids.coordinator, "coordinator");
  if (type === "no_equity_validated") return user(ids.fo, "functional_owner");
  if (type === "reassigned") return user(ids.supervisor, "supervisor");
  return user(ids.ta, "tasking_authority");
}

async function place(
  db: CoreDb,
  state: TaskerState,
  opts: { transmit?: boolean; released?: boolean; withGate?: boolean; gateStatus?: "open" | "concurred" } = {},
): Promise<string> {
  const id = randomUUID();
  const releasedDefault = ["ASSIGNED", "CLARIFICATION", "IN_WORK", "IN_COORDINATION", "AWAITING_APPROVAL"].includes(state);
  const released = opts.released ?? releasedDefault;
  const planId = randomUUID();
  placeSeq += 1;
  await db.insert(tasker).values({
    id,
    ref: `MF-2026-${String(8000 + placeSeq).padStart(4, "0")}`,
    title: `Placed ${state} ${id.slice(0, 8)}`,
    category: "awards_package",
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    targetOrgId: ids.squadron,
    requirement: "Fictional requirement.",
    deliverableFormat: "worksheet",
    externalSuspense: FAR,
    originatorId: ids.originator,
    state: state === "CLOSED" ? "IN_WORK" : state,
    submittedForReleaseAt: state === "DRAFT" ? null : NOW,
  });
  if (state !== "DRAFT") {
    await db.insert(suspensePlan).values({
      id: planId,
      taskerId: id,
      version: 1,
      externalSuspense: FAR,
      stages: [],
      contingencyBufferDays: 2,
      latestAoAssignmentDate: "2026-10-01",
      aoWindowPct: "0.5263",
      conflict: state === "SUSPENSE_CONFLICT",
    });
    await db
      .update(tasker)
      .set({
        currentSuspensePlanId: planId,
        ...(released ? { releasedAt: NOW, taskingAuthorityId: ids.ta, transmitToHigherHq: opts.transmit ?? false } : {}),
      })
      .where(eq(tasker.id, id));
  }
  await db.insert(taskerAssignment).values({ taskerId: id, userId: ids.originator, role: "originator", source: "manual", rationale: "Drafted by the originator", assignedBy: ids.originator });
  if (released || state === "CLOSED") {
    await db.insert(taskerAssignment).values([
      { taskerId: id, userId: ids.ao, role: "ao_primary", source: "registry_match", assignedBy: ids.ta },
      { taskerId: id, userId: ids.approver, role: "approver", source: "registry_match", assignedBy: ids.ta },
      { taskerId: id, userId: ids.coordinator, role: "coordinator", source: "registry_match", assignedBy: ids.ta },
      { taskerId: id, userId: ids.apo, role: "accountable_product_owner", source: "registry_match", assignedBy: ids.ta },
    ]);
  }
  if (opts.withGate && !(released || state === "CLOSED")) {
    await db.insert(taskerAssignment).values({
      taskerId: id,
      userId: ids.coordinator,
      role: "coordinator",
      source: "registry_match",
      assignedBy: ids.ta,
    });
  }
  if (opts.withGate) {
    await db.insert(gate).values({
      taskerId: id,
      kind: "coordination",
      sequence: 1,
      officeLabel: "Protocol",
      assigneeUserId: ids.coordinator,
      source: "registry_mandatory",
      justification: "Protocol reviews the fictional citation.",
      dueDate: FAR,
      status: state === "CLOSED" ? "auto_closed" : (opts.gateStatus ?? "open"),
    });
  }
  if (state === "CLOSED") {
    const [disp] = await db
      .insert((await import("../db/schema")).disposition)
      .values({
        taskerId: id,
        type: "cancelled_obe",
        appliedBy: ids.ta,
        actingRole: "tasking_authority",
        rationale: "Closed for the test.",
        fromState: "IN_WORK",
        toState: "CLOSED",
        closesTasker: true,
      })
      .returning();
    await db
      .update(tasker)
      .set({ state: "CLOSED", closedAt: NOW, closedDispositionType: "cancelled_obe", finalDispositionId: disp!.id })
      .where(eq(tasker.id, id));
  }
  if (state === "SUSPENSE_CONFLICT") {
    await db.update(tasker).set({ state: "SUSPENSE_CONFLICT" }).where(eq(tasker.id, id));
  }
  return id;
}

async function openGateId(db: CoreDb, taskerId: string): Promise<string> {
  const [row] = await db.select().from(gate).where(eq(gate.taskerId, taskerId));
  if (!row) throw new Error("missing gate");
  if (row.status !== "open") {
    await db.update(gate).set({ status: "open", assigneeUserId: ids.coordinator }).where(eq(gate.id, row.id));
  }
  return row.id;
}
