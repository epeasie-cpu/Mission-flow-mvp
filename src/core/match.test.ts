import { describe, expect, it } from "vitest";
import { matchTasker, type MatchEntry, type MatchWorld } from "./match";

const now = new Date("2026-10-11T16:00:00.000Z");

function entry(overrides: Partial<MatchEntry> = {}): MatchEntry {
  return {
    id: "entry-awards",
    responsibilityId: "LOG-READINESS-AWARDS-001",
    missionFunction: "logistics readiness awards",
    portfolio: "readiness awards",
    orgScope: { echelons: ["squadron", "wing"], org_ids: ["wing"] },
    accountablePositionId: "pos-apo",
    responsiblePositionId: "pos-ao",
    designatedAlternatePositionId: null,
    designatedAlternateUserId: "user-alt",
    supervisoryPositionId: "pos-sup",
    mandatoryCoordination: [
      { office: "Protocol", position_id: "pos-protocol", default_justification: "Protocol reviews the fictional citation." },
    ],
    designatedApproverPositionId: "pos-approver",
    baselineTimelineProfile: [{ stage: "ao_drafting", business_days: 10 }],
    applicabilityCriteria: { mission_codes_any: ["LOG-RDY"] },
    lastValidatedAt: now,
    status: "active",
    taskCategories: ["awards_package"],
    keywords: ["award", "nominee", "readiness"],
    ...overrides,
  };
}

function world(overrides: Partial<MatchWorld> = {}): MatchWorld {
  return {
    now,
    orgs: [
      { id: "wing", echelon: "wing", parentOrgId: null, missionCodes: ["LOG-RDY"] },
      { id: "squadron", echelon: "squadron", parentOrgId: "wing", missionCodes: ["LOG-RDY"] },
      { id: "fss", echelon: "squadron", parentOrgId: "wing", missionCodes: ["FSS-SVC"] },
    ],
    users: [
      { id: "user-ao", availability: "available", isActive: true },
      { id: "user-alt", availability: "available", isActive: true },
      { id: "user-pos-alt", availability: "available", isActive: true },
      { id: "user-apo", availability: "available", isActive: true },
      { id: "user-approver", availability: "available", isActive: true },
      { id: "user-sup", availability: "available", isActive: true },
      { id: "user-protocol", availability: "available", isActive: true },
      { id: "user-tc", availability: "available", isActive: true },
    ],
    positions: [
      { id: "pos-ao", orgId: "squadron", incumbentUserId: "user-ao", alternateUserId: "user-pos-alt" },
      { id: "pos-apo", orgId: "squadron", incumbentUserId: "user-apo", alternateUserId: null },
      { id: "pos-approver", orgId: "wing", incumbentUserId: "user-approver", alternateUserId: null },
      { id: "pos-sup", orgId: "squadron", incumbentUserId: "user-sup", alternateUserId: null },
      { id: "pos-protocol", orgId: "wing", incumbentUserId: "user-protocol", alternateUserId: null },
    ],
    grants: [{ userId: "user-tc", role: "task_controller", scopeOrgId: null, revokedAt: null }],
    entries: [entry()],
    ...overrides,
  };
}

const input = {
  category: "awards_package",
  missionFunction: "logistics readiness awards",
  portfolio: "readiness awards",
  targetOrgId: "squadron",
  title: "Quarterly award for a fictional nominee",
  requirement: "Draft award bullets for a fictional nominee.",
  now,
};

describe("registry match", () => {
  it("resolves the awards entry clearly, including people", () => {
    const result = matchTasker(input, world());
    expect(result.confidence).toBe("clear");
    expect(result.chosen).toBe("entry-awards");
    expect(result.route).toBe("assign");
    expect(result.failoverApplied).toBe(false);
    expect(result.resolved.aoPrimary).toEqual({ userId: "user-ao", source: "registry_match" });
    expect(result.resolved.aoAlternate?.userId).toBe("user-alt");
    expect(result.resolved.apo?.userId).toBe("user-apo");
    expect(result.resolved.approver?.userId).toBe("user-approver");
    expect(result.resolved.coordinators.map((item) => item.office)).toEqual(["Protocol"]);
    expect(result.resolved.awareness?.map((item) => item.userId).sort()).toEqual(["user-sup", "user-tc"]);
  });

  it("prefers the registry alternate over the position alternate when the primary is TDY", () => {
    const base = world();
    base.users = base.users.map((user) => (user.id === "user-ao" ? { ...user, availability: "tdy" } : user));
    const first = matchTasker(input, base);
    expect(first.failoverApplied).toBe(true);
    expect(first.resolved.aoPrimary).toEqual({ userId: "user-alt", source: "alternate_failover" });

    const secondWorld = world();
    secondWorld.users = secondWorld.users.map((user) =>
      user.id === "user-ao" || user.id === "user-alt" ? { ...user, availability: "tdy" } : user,
    );
    const second = matchTasker(input, secondWorld);
    expect(second.resolved.aoPrimary).toEqual({ userId: "user-pos-alt", source: "alternate_failover" });

    const thirdWorld = world();
    thirdWorld.users = thirdWorld.users.map((user) =>
      user.id === "user-ao" || user.id === "user-alt" || user.id === "user-pos-alt" ? { ...user, availability: "tdy" } : user,
    );
    const third = matchTasker(input, thirdWorld);
    expect(third.route).toBe("triage");
    expect(third.triageReason).toBe("no_ao_and_alternate");
  });

  it("sends no-match, ambiguous, and expired entries to triage", () => {
    expect(matchTasker({ ...input, missionFunction: "no such function" }, world()).confidence).toBe("none");
    expect(matchTasker({ ...input, targetOrgId: "fss" }, world()).route).toBe("triage");
    const expired = world({ entries: [entry({ status: "expired" })] });
    expect(matchTasker(input, expired).confidence).toBe("none");
    const twin = entry({ id: "entry-b", responsibilityId: "LOG-READINESS-AWARDS-002" });
    const ambiguous = matchTasker(input, world({ entries: [entry(), twin] }));
    expect(ambiguous.confidence).toBe("ambiguous");
    expect(ambiguous.route).toBe("triage");
  });

  it("is deterministic when scores tie", () => {
    const twin = entry({ id: "entry-b", responsibilityId: "AAA-BEFORE-001" });
    const first = matchTasker(input, world({ entries: [entry(), twin] }));
    const second = matchTasker(input, world({ entries: [twin, entry()] }));
    expect(first.candidates.map((item) => item.responsibilityId)).toEqual(second.candidates.map((item) => item.responsibilityId));
    expect(first.candidates[0]?.responsibilityId).toBe("AAA-BEFORE-001");
  });

  it("ignores unaccepted suggestion text that is not on the tasker", () => {
    const decoy = entry({
      id: "decoy",
      responsibilityId: "FSS-RECOGNITION-001",
      missionFunction: "force support recognition",
      applicabilityCriteria: { mission_codes_any: ["FSS-SVC"] },
      orgScope: { echelons: ["squadron"], org_ids: ["fss"] },
    });
    const suggestion = { field: "mission_function", suggestedValue: "force support recognition", accepted: false };
    expect(suggestion.accepted).toBe(false);
    const result = matchTasker(input, world({ entries: [entry(), decoy] }));
    expect(result.chosen).toBe("entry-awards");
    expect(result.confidence).toBe("clear");
  });
});
