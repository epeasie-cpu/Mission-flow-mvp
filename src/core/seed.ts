import { eq } from "drizzle-orm";
import { appUser, gate, holiday, org, position, roleGrant, smeInput, tasker, template } from "../db/schema";
import type { Actor } from "./actor";
import type { CoreDb } from "./db";
import { uploadDocument } from "./docs";
import {
  accept,
  acknowledge,
  applyDisposition,
  cancel,
  createDraft,
  raiseEscalation,
  release,
  requestClarification,
  sign,
  submitForRelease,
} from "./lifecycle";
import { decideGate, openGates, routeToApproval } from "./gates";
import { upsertEntry, validateEntry } from "./registry";
import { requestSme, submitSme } from "./sme";
import { seedNotionalDirectory } from "./seed-wing";

/** US federal holidays for 2026 and 2027. Observed dates are used when the calendar day is a weekend. */
export const FEDERAL_HOLIDAYS: { day: string; label: string }[] = [
  { day: "2026-01-01", label: "New Year's Day" },
  { day: "2026-01-19", label: "Birthday of Martin Luther King, Jr." },
  { day: "2026-02-16", label: "Washington's Birthday" },
  { day: "2026-05-25", label: "Memorial Day" },
  { day: "2026-06-19", label: "Juneteenth" },
  { day: "2026-07-03", label: "Independence Day (observed)" },
  { day: "2026-09-07", label: "Labor Day" },
  { day: "2026-10-12", label: "Columbus Day" },
  { day: "2026-11-11", label: "Veterans Day" },
  { day: "2026-11-26", label: "Thanksgiving Day" },
  { day: "2026-12-25", label: "Christmas Day" },
  { day: "2027-01-01", label: "New Year's Day" },
  { day: "2027-01-18", label: "Birthday of Martin Luther King, Jr." },
  { day: "2027-02-15", label: "Washington's Birthday" },
  { day: "2027-05-31", label: "Memorial Day" },
  { day: "2027-06-18", label: "Juneteenth (observed)" },
  { day: "2027-07-05", label: "Independence Day (observed)" },
  { day: "2027-09-06", label: "Labor Day" },
  { day: "2027-10-11", label: "Columbus Day" },
  { day: "2027-11-11", label: "Veterans Day" },
  { day: "2027-11-25", label: "Thanksgiving Day" },
  { day: "2027-12-24", label: "Christmas Day (observed)" },
  { day: "2027-12-31", label: "New Year's Day (observed)" },
];

const SEED_MARK = "[seed] ";
export const SEED_NOW = new Date("2026-10-11T16:00:00.000Z");

const person = (userId: string, actingRole: string): Actor => ({ type: "user", userId, actingRole });

export type SeedResult = {
  alreadySeeded: boolean;
  taskers: { title: string; ref: string; state: string }[];
};

export async function seedDemo(
  db: CoreDb,
  opts: { now?: Date; reset?: boolean; execReset?: () => Promise<void> } = {},
): Promise<SeedResult> {
  const now = opts.now ?? SEED_NOW;
  if (opts.reset) {
    if (!opts.execReset) throw new Error("reset requires execReset (owner role)");
    await opts.execReset();
  }
  for (const item of FEDERAL_HOLIDAYS) {
    await db.insert(holiday).values(item).onConflictDoNothing();
  }
  await seedNotionalDirectory(db);
  const [existing] = await db.select({ id: org.id }).from(org).where(eq(org.shortCode, "EXCOM")).limit(1);
  if (existing && !opts.reset) {
    const rows = await db.select({ title: tasker.title, ref: tasker.ref, state: tasker.state }).from(tasker);
    return { alreadySeeded: true, taskers: rows };
  }

  const [excom] = await db.insert(org).values({ name: "Example Command (EXCOM)", shortCode: "EXCOM", echelon: "majcom", missionCodes: [] }).returning();
  const [center] = await db
    .insert(org)
    .values({ name: "Example Center", shortCode: "ECEN", echelon: "center", parentOrgId: excom!.id, missionCodes: [] })
    .returning();
  const [wing] = await db
    .insert(org)
    .values({ name: "Sample Wing (SMW)", shortCode: "SMW", echelon: "wing", parentOrgId: center!.id, missionCodes: ["LOG-RDY"] })
    .returning();
  const [group] = await db
    .insert(org)
    .values({ name: "Sample Mission Support Group", shortCode: "SMSG", echelon: "group", parentOrgId: wing!.id, missionCodes: ["LOG-RDY"] })
    .returning();
  const [lrs] = await db
    .insert(org)
    .values({
      name: "Sample Logistics Readiness Squadron (S-LRS)",
      shortCode: "SLRS",
      echelon: "squadron",
      parentOrgId: group!.id,
      missionCodes: ["LOG-RDY"],
    })
    .returning();
  const [fss] = await db
    .insert(org)
    .values({
      name: "Sample Force Support Squadron (S-FSS)",
      shortCode: "SFSS",
      echelon: "squadron",
      parentOrgId: group!.id,
      missionCodes: ["FSS-SVC"],
    })
    .returning();

  async function user(displayName: string, email: string, orgId: string, billet: string, availability: "available" | "tdy" = "available") {
    const [row] = await db
      .insert(appUser)
      .values({ displayName, email, orgId, billetLabel: billet, availability })
      .returning();
    return row!;
  }

  const avery = await user("Avery Sample", "avery.sample@example.test", lrs!.id, "Task originator");
  const quinn = await user("Quinn Example", "quinn.example@example.test", excom!.id, "Task originator");
  const jordan = await user("Jordan Placeholder", "jordan.placeholder@example.test", excom!.id, "Tasking authority");
  const riley = await user("Riley Example", "riley.example@example.test", lrs!.id, "Readiness flight chief");
  const taylor = await user("Taylor Standin", "taylor.standin@example.test", lrs!.id, "Awards program manager");
  const casey = await user("Casey Sample", "casey.sample@example.test", lrs!.id, "Awards alternate");
  const skyler = await user("Skyler Placeholder", "skyler.placeholder@example.test", lrs!.id, "Coverage alternate", "tdy");
  const jamie = await user("Jamie Sample", "jamie.sample@example.test", lrs!.id, "LRS ops officer");
  const parker = await user("Parker Example", "parker.example@example.test", wing!.id, "Functional owner");
  const drew = await user("Drew Placeholder", "drew.placeholder@example.test", wing!.id, "Command section coordinator");
  const reese = await user("Reese Sample", "reese.sample@example.test", wing!.id, "Protocol coordinator");
  const cameron = await user("Cameron Placeholder", "cameron.placeholder@example.test", wing!.id, "Resource advisor");
  const hayden = await user("Hayden Example", "hayden.example@example.test", wing!.id, "Wing commander (synthetic)");
  const rowan = await user("Rowan Placeholder", "rowan.placeholder@example.test", excom!.id, "Task controller");
  const elliot = await user("Elliot Sample", "elliot.sample@example.test", excom!.id, "System administrator");
  const finley = await user("Finley Placeholder", "finley.placeholder@example.test", lrs!.id, "Staff contributor");

  async function seat(title: string, orgId: string, incumbentUserId: string, alternateUserId?: string) {
    const [row] = await db.insert(position).values({ title, orgId, incumbentUserId, alternateUserId: alternateUserId ?? null }).returning();
    return row!;
  }
  const apoSeat = await seat("Readiness flight chief", lrs!.id, riley.id);
  const aoSeat = await seat("Awards program manager", lrs!.id, taylor.id, skyler.id);
  const supervisorSeat = await seat("LRS ops officer", lrs!.id, jamie.id);
  const commandSeat = await seat("Command section", wing!.id, drew.id);
  const protocolSeat = await seat("Protocol", wing!.id, reese.id);
  const fmSeat = await seat("Resource office", wing!.id, cameron.id);
  await seat("Wing commander (synthetic)", wing!.id, hayden.id);

  async function grant(userId: string, role: "functional_owner" | "supervisor" | "task_controller" | "tasking_authority" | "approver" | "system_admin", scopeOrgId: string | null) {
    await db.insert(roleGrant).values({ userId, role, scopeOrgId, grantedBy: elliot.id });
  }
  await grant(jordan.id, "tasking_authority", null);
  await grant(parker.id, "functional_owner", null);
  await grant(jamie.id, "supervisor", lrs!.id);
  await grant(hayden.id, "approver", wing!.id);
  await grant(rowan.id, "task_controller", null);
  await grant(elliot.id, "system_admin", null);

  const [form] = await db
    .insert(template)
    .values({
      code: "AWARD-1206-BBP",
      name: "Fictional award worksheet",
      category: "awards_package",
      bodyMd: "Fictional nominee bullets. Led a sample project. Kept a sample process on schedule. No real person is described.",
    })
    .returning();

  const fo = person(parker.id, "functional_owner");
  const profile = [
    { stage: "ao_drafting", business_days: 10 },
    { stage: "coordination", business_days: 4 },
    { stage: "approval", business_days: 3 },
  ];
  const coordination = [
    { office: "Command Section", position_id: commandSeat.id, default_justification: "Command section reviews the fictional citation." },
    { office: "Protocol", position_id: protocolSeat.id, default_justification: "Protocol reviews the fictional citation." },
    { office: "Resource office", position_id: fmSeat.id, condition: "if funded", default_justification: "Resource office reviews only when the package is funded." },
  ];
  const live = await upsertEntry(db, fo, {
    responsibilityId: "LOG-READINESS-AWARDS-001",
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    orgScope: { echelons: ["squadron", "group", "wing"], org_ids: [wing!.id, lrs!.id] },
    accountablePositionId: apoSeat.id,
    responsiblePositionId: aoSeat.id,
    designatedAlternateUserId: casey.id,
    supervisoryPositionId: supervisorSeat.id,
    mandatoryCoordination: coordination,
    designatedApproverPositionId: (await db.select().from(position).where(eq(position.incumbentUserId, hayden.id)).limit(1))[0]!.id,
    standardTemplateId: form!.id,
    baselineTimelineProfile: profile,
    applicabilityCriteria: { mission_codes_any: ["LOG-RDY"] },
    taskCategories: ["awards_package"],
    keywords: ["award", "nominee", "readiness", "bullet"],
  });
  await validateEntry(db, fo, live.id, now);
  await upsertEntry(db, fo, {
    responsibilityId: "EXPIRED-AWARDS-009",
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    orgScope: { echelons: ["squadron"], org_ids: [lrs!.id] },
    accountablePositionId: apoSeat.id,
    responsiblePositionId: aoSeat.id,
    designatedAlternateUserId: casey.id,
    supervisoryPositionId: supervisorSeat.id,
    mandatoryCoordination: coordination,
    designatedApproverPositionId: live.designatedApproverPositionId,
    baselineTimelineProfile: profile,
    applicabilityCriteria: { mission_codes_any: ["LOG-RDY"] },
    taskCategories: ["awards_package"],
    keywords: ["award", "nominee"],
    status: "expired",
    lastValidatedAt: new Date("2024-01-15T00:00:00.000Z"),
    validatedBy: parker.id,
  });
  const decoy = await upsertEntry(db, fo, {
    responsibilityId: "FSS-RECOGNITION-001",
    missionFunction: "force support recognition",
    portfolio: "force support",
    orgScope: { echelons: ["squadron"], org_ids: [fss!.id] },
    accountablePositionId: apoSeat.id,
    responsiblePositionId: aoSeat.id,
    designatedAlternateUserId: casey.id,
    supervisoryPositionId: supervisorSeat.id,
    mandatoryCoordination: [],
    designatedApproverPositionId: live.designatedApproverPositionId,
    baselineTimelineProfile: profile,
    applicabilityCriteria: { mission_codes_any: ["FSS-SVC"] },
    taskCategories: ["awards_package"],
    keywords: ["recognition"],
  });
  await validateEntry(db, fo, decoy.id, now);

  const origin = person(avery.id, "originator");
  const ta = person(jordan.id, "tasking_authority");
  const ao = person(taylor.id, "ao_primary");
  const approver = person(hayden.id, "approver");

  async function start(title: string, suspense: string, originator = origin, target = lrs!.id, mission = "logistics readiness awards") {
    const created = await createDraft(db, originator, {
      title: SEED_MARK + title,
      category: "awards_package",
      missionFunction: mission,
      portfolio: "readiness awards",
      targetOrgId: target,
      requirement: "Prepare a fictional award worksheet. The nominee is invented. Bullets are sample text only.",
      deliverableFormat: "AWARD-1206-BBP",
      deliverableTemplateId: form!.id,
      externalSuspense: suspense,
      now,
    });
    const submitted = await submitForRelease(db, originator, created.id, now);
    return submitted.tasker;
  }

  const fresh = await start("Fresh quarterly award", "2027-06-30");
  await release(db, ta, fresh.id, { now });
  await acknowledge(db, ao, fresh.id);

  await start("Suspense conflict award", "2026-10-23");

  const inCoordination = await start("Coordination with a nonconcur", "2027-03-31");
  await release(db, ta, inCoordination.id, { includeConditional: true, now });
  await accept(db, ao, inCoordination.id, now);
  await uploadDocument(db, ao, inCoordination.id, {
    enclave: "draft",
    title: "Fictional citation draft",
    bodyMd: "Sample bullet: kept a made-up process on a made-up schedule.",
  });
  await openGates(db, ao, inCoordination.id);
  const opened = await db.select().from(gate).where(eq(gate.taskerId, inCoordination.id));
  const protocol = opened.find((item) => item.officeLabel === "Protocol");
  if (protocol) await decideGate(db, person(reese.id, "coordinator"), protocol.id, "nonconcur", "The fictional citation needs a clearer sample bullet.");
  await requestSme(db, ao, inCoordination.id, { smeUserId: finley.id, ask: "Add one fictional accomplishment bullet.", dueDate: "2027-01-15" });
  const inputs = await db.select().from(smeInput).where(eq(smeInput.taskerId, inCoordination.id));
  if (inputs[0]) await submitSme(db, person(finley.id, "sme_contributor"), inputs[0].id, "Fictional bullet: mentored a sample team through a sample exercise.");

  const rework = await start("Returned for rework", "2027-04-30");
  await release(db, ta, rework.id, { now });
  await accept(db, ao, rework.id, now);
  await openGates(db, ao, rework.id);
  const reworkGates = await db.select().from(gate).where(eq(gate.taskerId, rework.id));
  for (const item of reworkGates.filter((gate) => gate.kind === "coordination")) {
    await decideGate(db, person(item.assigneeUserId!, "coordinator"), item.id, "concur", "Sample concur.");
  }
  await routeToApproval(db, ao, rework.id);
  await applyDisposition(db, approver, rework.id, "returned_for_rework", { rationale: "The fictional citation needs another sample bullet." });

  const completed = await start("Wing-internal quarterly award", "2027-05-29");
  await release(db, ta, completed.id, { now });
  await accept(db, ao, completed.id, now);
  await uploadDocument(db, origin, completed.id, {
    enclave: "original",
    title: "Original directive",
    bodyMd: "MEMORANDUM FOR RECORD. Subject: fictional recognition. Reference: SAMPLE-000. This text is placeholder copy.",
  });
  await uploadDocument(db, ao, completed.id, {
    enclave: "final",
    title: "Fictional signed citation",
    bodyMd: "Fictional nominee. Sample bullet one. Sample bullet two. Signed in this demo only.",
  });
  await openGates(db, ao, completed.id);
  const doneGates = await db.select().from(gate).where(eq(gate.taskerId, completed.id));
  for (const item of doneGates.filter((gate) => gate.kind === "coordination")) {
    await decideGate(db, person(item.assigneeUserId!, "coordinator"), item.id, "concur");
  }
  await routeToApproval(db, ao, completed.id);
  await sign(db, approver, completed.id, "Signed for the demo.");

  const submitted = await start("EXCOM annual award", "2027-08-31", person(quinn.id, "originator"));
  await release(db, ta, submitted.id, { now });
  await accept(db, ao, submitted.id, now);
  await openGates(db, ao, submitted.id);
  const upGates = await db.select().from(gate).where(eq(gate.taskerId, submitted.id));
  for (const item of upGates.filter((gate) => gate.kind === "coordination")) {
    await decideGate(db, person(item.assigneeUserId!, "coordinator"), item.id, "concur");
  }
  await routeToApproval(db, ao, submitted.id);
  await sign(db, approver, submitted.id);

  const clarification = await start("Clarification with an open escalation", "2027-02-26");
  await release(db, ta, clarification.id, { now });
  await requestClarification(db, ao, clarification.id, "Which fictional quarter does this sample package cover?");
  await raiseEscalation(db, person(jamie.id, "supervisor"), clarification.id, "The sample team is short one reviewer.");

  await start("Unmatched triage item", "2027-06-30", origin, fss!.id, "no such function");

  const dropped = await createDraft(db, origin, {
    title: SEED_MARK + "Cancelled requirement",
    category: "awards_package",
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    targetOrgId: lrs!.id,
    requirement: "This fictional request is withdrawn before release.",
    deliverableFormat: "AWARD-1206-BBP",
    externalSuspense: "2027-06-30",
    now,
  });
  await cancel(db, origin, dropped.id, "Overtaken by a newer fictional request.");

  const rows = await db.select({ title: tasker.title, ref: tasker.ref, state: tasker.state }).from(tasker);
  return { alreadySeeded: false, taskers: rows };
}
