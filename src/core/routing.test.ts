import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { appUser, auditEvent, notification, org, outboundEmail, storedDocument } from "../db/schema";
import { Forbidden, ValidationError } from "./errors";
import { classifyUpload, FILE_MAX_BYTES, uploadStoredDocument } from "./files";
import { chainNotice } from "./notify";
import { createPerson, leadersToNotify, listDirectory, updatePerson } from "./personnel";
import { issueRoutedTasking, matchActionOfficers } from "./routing";
import { seedNotionalDirectory } from "./seed-wing";
import { createHarness, type Harness } from "../test/harness";

const NOW = new Date("2026-10-13T16:00:00.000Z");
const TITLE = "Quarterly awards worksheets";
const SUSPENSE = "2027-04-15";

describe("routing and notification fan-out", () => {
  let harness: Harness;
  let wingOrgId: string;

  beforeAll(async () => {
    harness = await createHarness();
    const seeded = await seedNotionalDirectory(harness.db);
    wingOrgId = seeded.wingOrgId;
  });

  afterAll(async () => {
    await harness.client.close();
  });

  async function userId(email: string): Promise<string> {
    const [row] = await harness.db.select({ id: appUser.id }).from(appUser).where(eq(appUser.email, email)).limit(1);
    if (!row) throw new Error(email);
    return row.id;
  }

  it("seeds a fictional wing of about 30 to 40 people and can run twice", async () => {
    const rows = await listDirectory(harness.db, { orgId: wingOrgId });
    expect(rows.length).toBeGreaterThanOrEqual(30);
    expect(rows.length).toBeLessThanOrEqual(40);
    expect(rows.filter((row) => row.duties.includes("Awards Monitor"))).toHaveLength(5);
    const again = await seedNotionalDirectory(harness.db);
    expect(again.inserted).toBe(false);
    expect(again.wingOrgId).toBe(wingOrgId);
    expect(await listDirectory(harness.db, { orgId: wingOrgId })).toHaveLength(rows.length);
  });

  it("matches action officers by additional duty, unit, AFSC, or name", async () => {
    const monitors = await matchActionOfficers(harness.db, { additionalDuty: "Awards Monitor" });
    expect(monitors.map((row) => row.displayName).sort()).toEqual([
      "Blake Pell",
      "Lou Mercer",
      "Nico Vale",
      "Sage Ibarra",
      "Wynn Okada",
    ]);
    const [logistics] = await harness.db.select({ id: org.id }).from(org).where(eq(org.shortCode, "NLS")).limit(1);
    const narrowed = await matchActionOfficers(harness.db, { additionalDuty: "awards monitor", orgIds: [logistics!.id] });
    expect(narrowed.map((row) => row.email)).toEqual(["blake.pell@example.test"]);
    const byAfsc = await matchActionOfficers(harness.db, { additionalDuty: "Awards Monitor", afscs: ["2f0x1"] });
    expect(byAfsc.map((row) => row.email)).toEqual(["blake.pell@example.test"]);
    const bess = await userId("bess.lang@example.test");
    const named = await matchActionOfficers(harness.db, { additionalDuty: "Awards Monitor", userIds: [bess] });
    expect(named.map((row) => row.email).sort()).toEqual([
      "bess.lang@example.test",
      "blake.pell@example.test",
      "lou.mercer@example.test",
      "nico.vale@example.test",
      "sage.ibarra@example.test",
      "wynn.okada@example.test",
    ]);
    const deployed = await matchActionOfficers(harness.db, { additionalDuty: "Unit Deployment Manager" });
    expect(deployed.some((row) => row.email === "zed.parker@example.test")).toBe(false);
    expect(await matchActionOfficers(harness.db, {})).toEqual([]);
  });

  it("creates one tasker per match and notifies the chain", async () => {
    const morgan = await userId("morgan.calder@example.test");
    const blake = await userId("blake.pell@example.test");
    const sloane = await userId("sloane.harlow@example.test");
    const kit = await userId("kit.ramsey@example.test");
    const eden = await userId("eden.marlow@example.test");
    const bess = await userId("bess.lang@example.test");
    const actor = { type: "user" as const, userId: morgan, actingRole: "tasking_authority" };
    await expect(
      issueRoutedTasking(harness.db, { type: "user", userId: blake, actingRole: "enterprise_participant" }, {
        title: TITLE,
        description: "Fictional worksheets only.",
        externalSuspense: SUSPENSE,
        priority: "routine",
        category: "awards_package",
        criteria: { additionalDuty: "Awards Monitor" },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(Forbidden);

    const issued = await issueRoutedTasking(harness.db, actor, {
      title: TITLE,
      description: "Prepare fictional quarterly awards worksheets. No real person is described.",
      externalSuspense: SUSPENSE,
      priority: "priority",
      category: "awards_package",
      criteria: { additionalDuty: "Awards Monitor" },
      files: [{ fileName: "sample-notes.txt", mime: "text/plain", content: Buffer.from("Fictional worksheet notes.\n") }],
      now: NOW,
    });
    expect(issued.taskers).toHaveLength(5);
    const blakeTasker = issued.taskers.find((row) => row.assigneeId === blake);
    expect(blakeTasker).toBeTruthy();

    const leaders = await leadersToNotify(harness.db, blake);
    expect(leaders.map((row) => row.id)).toEqual(expect.arrayContaining([sloane, kit, eden]));
    expect(leaders.some((row) => row.id === morgan)).toBe(false);
    expect(leaders.some((row) => row.id === bess)).toBe(false);

    const taskerIds = issued.taskers.map((row) => row.id);
    const notes = await harness.db.select().from(notification).where(inArray(notification.taskerId, taskerIds));
    const blakeNotes = notes.filter((row) => row.taskerId === blakeTasker!.id);
    expect(blakeNotes.find((row) => row.recipientUserId === blake)?.body).toBe(
      `You were tasked with ${TITLE}, suspense ${SUSPENSE}.`,
    );
    expect(blakeNotes.find((row) => row.recipientUserId === sloane)?.body).toBe(chainNotice("Blake Pell", TITLE, SUSPENSE));
    expect(blakeNotes.find((row) => row.recipientUserId === kit)?.kind).toBe("chain");
    expect(blakeNotes.find((row) => row.recipientUserId === eden)?.kind).toBe("chain");
    expect(blakeNotes.some((row) => row.recipientUserId === morgan)).toBe(false);
    expect(blakeNotes.some((row) => row.recipientUserId === bess)).toBe(false);

    const wynn = await userId("wynn.okada@example.test");
    const wynnTasker = issued.taskers.find((row) => row.assigneeId === wynn);
    const wynnNotes = notes.filter((row) => row.taskerId === wynnTasker!.id);
    expect(wynnNotes.some((row) => row.recipientUserId === sloane)).toBe(false);
    expect(wynnNotes.find((row) => row.recipientUserId === wynn)?.kind).toBe("assigned");

    const mail = await harness.db
      .select()
      .from(outboundEmail)
      .where(inArray(outboundEmail.notificationId, notes.map((row) => row.id)));
    expect(mail).toHaveLength(notes.length);
    expect(mail.every((row) => row.simulated && row.toEmail.endsWith("@example.test"))).toBe(true);
    expect(mail.find((row) => row.toEmail === "sloane.harlow@example.test" && row.body.includes("Blake Pell"))?.subject).toMatch(/Chain tasking/);

    const audits = await harness.db.select().from(auditEvent).where(inArray(auditEvent.taskerId, taskerIds));
    expect(audits.some((row) => row.eventType === "tasker.routed")).toBe(true);
    expect(audits.some((row) => row.eventType === "tasker.created")).toBe(true);
    expect(audits.some((row) => row.eventType === "notification.created")).toBe(true);
    expect(audits.some((row) => row.eventType === "stored_document.uploaded")).toBe(true);

    const [file] = await harness.db.select().from(storedDocument).where(eq(storedDocument.taskerId, blakeTasker!.id));
    expect(file?.fileName).toBe("sample-notes.txt");
    expect(file?.byteSize).toBeGreaterThan(0);
    expect(file?.sha256).toHaveLength(64);
  });

  it("rejects disallowed or oversized files and keeps stored documents append-only", async () => {
    expect(() => classifyUpload("notes.exe", "application/octet-stream")).toThrow(ValidationError);
    expect(() => classifyUpload("notes.pdf", "text/html")).toThrow(ValidationError);
    const morgan = await userId("morgan.calder@example.test");
    const blake = await userId("blake.pell@example.test");
    const [taskerRow] = await harness.db
      .select({ taskerId: notification.taskerId })
      .from(notification)
      .where(eq(notification.recipientUserId, blake))
      .limit(1);
    await expect(
      uploadStoredDocument(harness.db, { type: "user", userId: morgan, actingRole: "tasking_authority" }, taskerRow!.taskerId!, {
        fileName: "too-big.txt",
        mime: "text/plain",
        content: Buffer.alloc(FILE_MAX_BYTES + 1, 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(harness.client.exec("update stored_document set file_name = 'changed.txt'")).rejects.toThrow(/append-only/);
    await expect(harness.client.exec("delete from outbound_email")).rejects.toThrow(/append-only/);
  });

  it("audits directory edits", async () => {
    const jules = await userId("jules.adler@example.test");
    const admin = { type: "user" as const, userId: jules, actingRole: "system_admin" };
    const created = await createPerson(harness.db, admin, {
      displayName: "Nova Quint",
      email: "nova.quint@example.test",
      orgId: wingOrgId,
      rank: "Capt",
      billetLabel: "Staff officer",
      afsc: "16R3",
      primaryDuty: "Plans",
      functions: ["plans"],
      supervisorUserId: jules,
      leadershipTitle: null,
      duties: ["Safety Rep"],
    });
    await updatePerson(harness.db, admin, created.id, {
      displayName: "Nova Quint",
      email: "nova.quint@example.test",
      orgId: wingOrgId,
      rank: "Maj",
      billetLabel: "Staff officer",
      afsc: "16R3",
      primaryDuty: "Plans",
      functions: ["plans"],
      supervisorUserId: jules,
      leadershipTitle: null,
      duties: ["Safety Rep", "Awards Monitor"],
    });
    const events = await harness.db.select().from(auditEvent).where(eq(auditEvent.entityId, created.id));
    expect(events.map((row) => row.eventType)).toEqual(expect.arrayContaining(["personnel.created", "personnel.updated"]));
    const updated = events.find((row) => row.eventType === "personnel.updated");
    const payload = updated?.payload as { before?: { rank?: string }; after?: { rank?: string; duties?: string[] } };
    expect(payload.before?.rank).toBe("Capt");
    expect(payload.after?.rank).toBe("Maj");
    expect(payload.after?.duties).toContain("Awards Monitor");
    await expect(
      updatePerson(harness.db, { type: "user", userId: await userId("blake.pell@example.test"), actingRole: "enterprise_participant" }, created.id, {
        displayName: "Nova Quint",
        email: "nova.quint@example.test",
        orgId: wingOrgId,
        rank: "Maj",
        billetLabel: "Staff officer",
        afsc: "16R3",
        primaryDuty: "Plans",
        functions: [],
        supervisorUserId: null,
        leadershipTitle: null,
        duties: [],
      }),
    ).rejects.toBeInstanceOf(Forbidden);
  });
});
