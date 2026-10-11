import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appUser } from "../db/schema";
import { can, NotFound, reads, seedDemo, SEED_NOW, signInAsPersona, switchActingRole } from "../core";
import { createHarness, resetDemo, type Harness } from "../test/harness";
import { landingFor } from "./landing";

process.env.DEMO_PASSCODE = "demo-pass-test";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";

describe("signed-in walkthrough", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
    await resetDemo(harness.client);
    await seedDemo(harness.db, { now: SEED_NOW });
  }, 60_000);

  afterAll(async () => {
    await harness.client.close();
  });

  async function persona(email: string) {
    const [user] = await harness.db.select().from(appUser).where(eq(appUser.email, email)).limit(1);
    if (!user) throw new Error(email);
    let signed = await signInAsPersona(harness.db, user.id, "demo-pass-test");
    return signed;
  }

  it("signs an action officer in, lands on the work list, and opens a tasker", async () => {
    let signed = await persona("taylor.standin@example.test");
    if (signed.session.heldRoles.includes("ao_primary")) {
      signed = await switchActingRole(harness.db, signed.session, "ao_primary");
    }
    expect(landingFor(signed.session.actingRole)).toBe("/work");
    const actor = { type: "user" as const, userId: signed.session.userId, actingRole: signed.session.actingRole };
    const list = await reads.listVisibleTaskers(harness.db, actor);
    const fresh = list.find((row) => row.title.includes("Fresh quarterly"));
    expect(fresh?.state).toBe("ASSIGNED");
    expect(fresh?.aoName).toBe("Taylor Standin");
    expect(fresh?.externalSuspense).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const detail = await reads.readTaskerDetail(harness.db, actor, fresh!.id);
    expect(detail.tasker.ref).toBe(fresh!.ref);
    expect(detail.tasker.requirement.length).toBeGreaterThan(0);
    expect(detail.gates.length).toBeGreaterThan(0);
    expect(detail.plan?.conflict).toBe(false);
    expect(detail.audit.some((event) => event.eventType === "tasker.released")).toBe(true);
    expect(await can(harness.db, actor, "tasker.accept", { taskerId: fresh!.id })).toBe(true);
  });

  it("lands a tasking authority on oversight counts that include a conflict and triage", async () => {
    const signed = await persona("jordan.placeholder@example.test");
    expect(signed.session.actingRole).toBe("tasking_authority");
    expect(landingFor(signed.session.actingRole)).toBe("/oversight");
    const actor = { type: "user" as const, userId: signed.session.userId, actingRole: signed.session.actingRole };
    const summary = await reads.summarizeVisible(harness.db, actor);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.conflicts).toBeGreaterThan(0);
    expect(summary.triage).toBeGreaterThan(0);
    expect(summary.byState.find((row) => row.state === "ASSIGNED")?.count).toBeGreaterThan(0);
  });

  it("hides taskers from the system administrator", async () => {
    const signed = await persona("elliot.sample@example.test");
    expect(landingFor(signed.session.actingRole)).toBe("/oversight");
    const actor = { type: "user" as const, userId: signed.session.userId, actingRole: signed.session.actingRole };
    expect(await reads.listVisibleTaskers(harness.db, actor)).toEqual([]);
    const summary = await reads.summarizeVisible(harness.db, actor);
    expect(summary.total).toBe(0);
    const [anyTasker] = await reads.listVisibleTaskers(
      harness.db,
      { type: "user", userId: (await persona("avery.sample@example.test")).session.userId, actingRole: "originator" },
    );
    await expect(reads.readTaskerDetail(harness.db, actor, anyTasker!.id)).rejects.toBeInstanceOf(NotFound);
  });
});
