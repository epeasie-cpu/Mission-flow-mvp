import { ECHELON_RANK, matching, type Echelon } from "../config/missionflow.config";
import type { ApplicabilityCriteria, MandatoryCoordination, OrgScope, TimelineProfile } from "../db/schema";

export type MatchOrg = {
  id: string;
  echelon: Echelon;
  parentOrgId: string | null;
  missionCodes: string[];
};

export type MatchUser = {
  id: string;
  availability: string;
  isActive: boolean;
};

export type MatchPosition = {
  id: string;
  orgId: string;
  incumbentUserId: string | null;
  alternateUserId: string | null;
};

export type MatchGrant = {
  userId: string;
  role: string;
  scopeOrgId: string | null;
  revokedAt: Date | null;
};

export type MatchEntry = {
  id: string;
  responsibilityId: string;
  missionFunction: string;
  portfolio: string;
  orgScope: OrgScope;
  accountablePositionId: string;
  responsiblePositionId: string;
  designatedAlternatePositionId: string | null;
  designatedAlternateUserId: string | null;
  supervisoryPositionId: string;
  mandatoryCoordination: MandatoryCoordination;
  designatedApproverPositionId: string;
  baselineTimelineProfile: TimelineProfile;
  applicabilityCriteria: ApplicabilityCriteria | null;
  lastValidatedAt: Date | null;
  status: string;
  taskCategories: string[];
  keywords: string[];
};

export type MatchInput = {
  category: string;
  missionFunction: string;
  portfolio?: string | null;
  targetOrgId: string;
  title: string;
  requirement: string;
  now: Date;
};

export type MatchCandidate = {
  entryId: string;
  responsibilityId: string;
  score: number;
  specificity: number;
  reasons: string[];
};

export type ResolvedPeople = {
  aoPrimary?: { userId: string; source: "registry_match" | "alternate_failover" };
  aoAlternate?: { userId: string };
  apo?: { userId: string };
  approver?: { userId: string };
  coordinators: { userId: string; office: string; positionId: string; condition?: string; justification: string }[];
  awareness: { userId: string }[];
};

export type MatchResult = {
  candidates: MatchCandidate[];
  chosen?: string;
  confidence: "clear" | "ambiguous" | "none";
  resolved: ResolvedPeople;
  failoverApplied: boolean;
  route: "assign" | "triage";
  triageReason?: string;
  profile: TimelineProfile;
};

export type MatchWorld = {
  orgs: MatchOrg[];
  users: MatchUser[];
  positions: MatchPosition[];
  entries: MatchEntry[];
  grants: MatchGrant[];
  now: Date;
};

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function chainOf(orgs: MatchOrg[], orgId: string): MatchOrg[] {
  const byId = new Map(orgs.map((row) => [row.id, row]));
  const chain: MatchOrg[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(orgId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentOrgId ? byId.get(cursor.parentOrgId) : undefined;
  }
  return chain;
}

function userById(world: MatchWorld, id: string | null | undefined): MatchUser | undefined {
  if (!id) return undefined;
  return world.users.find((user) => user.id === id);
}

function available(user: MatchUser | undefined): user is MatchUser {
  return !!user && user.isActive && user.availability === "available";
}

function positionById(world: MatchWorld, id: string | null | undefined): MatchPosition | undefined {
  if (!id) return undefined;
  return world.positions.find((position) => position.id === id);
}

function incumbent(world: MatchWorld, positionId: string | null | undefined): string | null {
  return positionById(world, positionId)?.incumbentUserId ?? null;
}

function withinCycle(last: Date | null, now: Date): boolean {
  if (!last) return false;
  const days = (now.getTime() - last.getTime()) / 86_400_000;
  return days >= 0 && days <= matching.validationCycleDays.quarterly;
}

export function matchTasker(input: MatchInput, world: MatchWorld): MatchResult {
  const targetChain = chainOf(world.orgs, input.targetOrgId);
  const target = targetChain[0];
  const textTokens = tokens(`${input.title} ${input.requirement}`);
  const candidates: MatchCandidate[] = [];

  for (const entry of world.entries) {
    if (entry.status !== "active") continue;
    if (!withinCycle(entry.lastValidatedAt, input.now)) continue;
    if (!entry.taskCategories.includes(input.category)) continue;
    if (entry.missionFunction.trim().toLowerCase() !== input.missionFunction.trim().toLowerCase()) continue;
    if (!target) continue;
    const scopeIds = new Set(entry.orgScope.org_ids ?? []);
    const scopeEchelons = new Set(entry.orgScope.echelons ?? []);
    const orgIdHit = targetChain.some((item) => scopeIds.has(item.id));
    const echelonHit = targetChain.some((item) => scopeEchelons.has(item.echelon));
    if (!orgIdHit && !echelonHit) continue;
    if (entry.applicabilityCriteria?.mission_codes_any?.length) {
      const codes = new Set(target.missionCodes);
      const hit = entry.applicabilityCriteria.mission_codes_any.some((code) => codes.has(code));
      if (!hit) continue;
    }
    const reasons: string[] = ["hard filters passed"];
    let score = 0;
    if (input.portfolio && input.portfolio.trim().toLowerCase() === entry.portfolio.trim().toLowerCase()) {
      score += matching.portfolioMatchScore;
      reasons.push("portfolio");
    }
    const overlap = jaccard(textTokens, tokens(entry.keywords.join(" ")));
    const keywordScore = Math.round(overlap * matching.keywordOverlapMaxScore);
    if (keywordScore > 0) {
      score += keywordScore;
      reasons.push("keywords");
    }
    const specificity = orgIdHit ? matching.orgIdSpecificityScore : matching.echelonSpecificityScore;
    score += specificity;
    reasons.push(orgIdHit ? "org id" : "echelon");
    candidates.push({
      entryId: entry.id,
      responsibilityId: entry.responsibilityId,
      score,
      specificity,
      reasons,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    const aEntry = world.entries.find((entry) => entry.id === a.entryId);
    const bEntry = world.entries.find((entry) => entry.id === b.entryId);
    const aTime = aEntry?.lastValidatedAt?.getTime() ?? 0;
    const bTime = bEntry?.lastValidatedAt?.getTime() ?? 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.responsibilityId < b.responsibilityId ? -1 : a.responsibilityId > b.responsibilityId ? 1 : 0;
  });

  let confidence: MatchResult["confidence"] = "none";
  if (candidates.length === 1) confidence = "clear";
  else if (candidates.length > 1) {
    confidence = candidates[0]!.score - candidates[1]!.score >= matching.clearMarginMin ? "clear" : "ambiguous";
  }

  const empty: ResolvedPeople = { coordinators: [], awareness: [] };
  if (confidence !== "clear") {
    return {
      candidates,
      confidence,
      resolved: empty,
      failoverApplied: false,
      route: "triage",
      triageReason: confidence === "none" ? "no_match" : "ambiguous",
      profile: [],
    };
  }

  const chosen = candidates[0]!.entryId;
  const entry = world.entries.find((item) => item.id === chosen)!;
  const resolved = resolvePeople(entry, world, targetChain);
  if (!resolved.aoPrimary || !resolved.aoAlternate || !resolved.apo || !resolved.approver) {
    return {
      candidates,
      chosen,
      confidence,
      resolved,
      failoverApplied: false,
      route: "triage",
      triageReason: !resolved.aoPrimary || !resolved.aoAlternate ? "no_ao_and_alternate" : "incomplete_resolution",
      profile: entry.baselineTimelineProfile,
    };
  }
  return {
    candidates,
    chosen,
    confidence,
    resolved,
    failoverApplied: resolved.aoPrimary.source === "alternate_failover",
    route: "assign",
    profile: entry.baselineTimelineProfile,
  };
}

function resolvePeople(entry: MatchEntry, world: MatchWorld, targetChain: MatchOrg[]): ResolvedPeople {
  const primaryId = incumbent(world, entry.responsiblePositionId);
  const designatedId = entry.designatedAlternateUserId ?? incumbent(world, entry.designatedAlternatePositionId);
  const positionAltId = positionById(world, entry.responsiblePositionId)?.alternateUserId ?? null;
  const primary = userById(world, primaryId);
  let aoPrimary: ResolvedPeople["aoPrimary"];
  if (available(primary) && primaryId) aoPrimary = { userId: primaryId, source: "registry_match" };
  else if (available(userById(world, designatedId)) && designatedId) {
    aoPrimary = { userId: designatedId, source: "alternate_failover" };
  } else if (available(userById(world, positionAltId)) && positionAltId) {
    aoPrimary = { userId: positionAltId, source: "alternate_failover" };
  }
  const alternateId = designatedId ?? positionAltId;
  const apoId = incumbent(world, entry.accountablePositionId);
  const approverId = incumbent(world, entry.designatedApproverPositionId);
  const coordinators = entry.mandatoryCoordination.flatMap((item) => {
    const userId = incumbent(world, item.position_id);
    if (!userId) return [];
    return [
      {
        userId,
        office: item.office,
        positionId: item.position_id,
        ...(item.condition ? { condition: item.condition } : {}),
        justification: item.default_justification ?? `Coordination with ${item.office}`,
      },
    ];
  });
  const awareness = new Set<string>();
  const supervisorId = incumbent(world, entry.supervisoryPositionId);
  if (supervisorId) awareness.add(supervisorId);
  const wingRank = ECHELON_RANK.wing;
  const chainIds = new Set(targetChain.map((item) => item.id));
  for (const grant of world.grants) {
    if (grant.revokedAt) continue;
    if (grant.role === "task_controller") awareness.add(grant.userId);
    if (grant.role === "supervisor" && grant.scopeOrgId && chainIds.has(grant.scopeOrgId)) {
      const scoped = targetChain.find((item) => item.id === grant.scopeOrgId);
      if (scoped && ECHELON_RANK[scoped.echelon] <= wingRank) awareness.add(grant.userId);
    }
  }
  return {
    ...(aoPrimary ? { aoPrimary } : {}),
    ...(alternateId ? { aoAlternate: { userId: alternateId } } : {}),
    ...(apoId ? { apo: { userId: apoId } } : {}),
    ...(approverId ? { approver: { userId: approverId } } : {}),
    coordinators,
    awareness: [...awareness].map((userId) => ({ userId })),
  };
}
