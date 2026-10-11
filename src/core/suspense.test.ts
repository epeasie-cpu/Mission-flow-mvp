import { describe, expect, it } from "vitest";
import { businessToday, isSuspenseConflict } from "../config/missionflow.config";
import { actionsFrom, transitionTo } from "./transitions";
import { computeSuspensePlan, subtractBusinessDays } from "./suspense";

describe("suspense calendar", () => {
  it("subtracts business days without counting the start date", () => {
    expect(subtractBusinessDays("2026-10-02", 1, [])).toBe("2026-10-01");
    expect(subtractBusinessDays("2026-10-02", 5, [])).toBe("2026-09-25");
  });

  it("skips a seeded holiday", () => {
    expect(subtractBusinessDays("2026-10-13", 1, ["2026-10-12"])).toBe("2026-10-09");
  });

  it("uses 17 profile days plus the buffer", () => {
    const plan = computeSuspensePlan({
      externalSuspense: "2026-12-18",
      profile: [
        { stage: "ao_drafting", business_days: 10 },
        { stage: "coordination", business_days: 4 },
        { stage: "approval", business_days: 3 },
      ],
      bufferDays: 2,
      holidays: [],
      now: new Date("2026-10-11T16:00:00.000Z"),
    });
    expect(plan.totalBusinessDays).toBe(19);
    expect(plan.latestAoAssignmentDate).toBe(subtractBusinessDays("2026-12-18", 19, []));
    expect(plan.warning).toBeNull();
  });

  it("warns below 35 percent and does not treat the warning as a conflict by itself", () => {
    const plan = computeSuspensePlan({
      externalSuspense: "2027-06-30",
      profile: [
        { stage: "ao_drafting", business_days: 2 },
        { stage: "coordination", business_days: 10 },
      ],
      bufferDays: 0,
      now: new Date("2026-10-11T16:00:00.000Z"),
    });
    expect(Number(plan.aoWindowPct)).toBeLessThan(0.35);
    expect(plan.warning).toBeTruthy();
    expect(plan.conflict).toBe(false);
  });

  it("keeps business today on the Chicago date at 23:30", () => {
    const now = new Date("2026-10-12T04:30:00.000Z");
    expect(businessToday(now, "America/Chicago")).toBe("2026-10-11");
    expect(isSuspenseConflict("2026-10-11", now)).toBe(false);
    expect(isSuspenseConflict("2026-10-10", now)).toBe(true);
  });
});

describe("transition table", () => {
  it("rejects edges that are not in the lifecycle and stops at CLOSED", () => {
    expect(() => transitionTo("DRAFT", "release")).toThrow(/not allowed/);
    expect(actionsFrom("CLOSED")).toEqual([]);
    expect(() => transitionTo("CLOSED", "cancel")).toThrow(/CLOSED/);
    expect(transitionTo("IN_COORDINATION", "reassign")).toBe("ASSIGNED");
    expect(transitionTo("AWAITING_APPROVAL", "reassign")).toBe("ASSIGNED");
    expect(transitionTo("ASSIGNED", "cancel")).toBe("CLOSED");
  });
});
