/**
 * MissionFlow runtime configuration (DRAFT v0.2 — applies shared-core-spec v0.2 gap rulings).
 * All former ⏳ defaults were APPROVED by Ryan on 2026-10-10 (pilot, closing set, AO-window warn-only, G19);
 * they stay config-reversible.
 *
 * Every "default pending Ryan's approval" lives here so it can be changed in one
 * place (or overridden by env var) without touching the schema or lifecycle code.
 * The DB schema deliberately does NOT hardcode: the pilot category, the closing
 * disposition set, the AI provider, or the buffer/warning thresholds.
 *
 * Synthetic data only. No real units, people, CUI, or government-system data.
 */

// ---------------------------------------------------------------------------
// Enum value lists (single source of truth; schema.ts builds pgEnums from these)
// ---------------------------------------------------------------------------

export const TASK_CATEGORIES = [
  "awards_package",
  "readiness_data_call",
  "rfi",
  "staff_summary",
  "policy_coordination",
] as const; // charter §13 (spec §2.2 Tasker.category)
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const DISPOSITION_TYPES = [
  "completed",
  "submitted",
  "concurred",
  "nonconcurred",
  "no_equity_validated",
  "reassigned",
  "cancelled_obe",
  "returned_for_rework",
] as const; // charter §8.1, spec §4 — exactly eight
export type DispositionType = (typeof DISPOSITION_TYPES)[number];

export const TASKER_STATES = [
  "DRAFT",
  "PENDING_RELEASE",
  "SUSPENSE_CONFLICT",
  "TRIAGE",
  "ASSIGNED",
  "CLARIFICATION",
  "IN_WORK",
  "IN_COORDINATION",
  "AWAITING_APPROVAL",
  "CLOSED",
] as const; // spec v0.2 §4.3: no ESCALATED (G3 overlay), single terminal CLOSED (G15)
export type TaskerState = (typeof TASKER_STATES)[number];

// ---------------------------------------------------------------------------
// Pilot scope (approved: awards first, RFI second)
// ---------------------------------------------------------------------------

export const pilot = {
  /** Categories the UI/API will accept for new taskers. Others exist in the enum but are disabled. */
  enabledCategories: (process.env.MF_ENABLED_CATEGORIES?.split(",") as TaskCategory[] | undefined) ?? [
    "awards_package",
  ],
  /** Planned next category (informational; flip by adding to enabledCategories). */
  nextCategory: "rfi" as TaskCategory,
};

// ---------------------------------------------------------------------------
// Dispositions (approved closing set, spec v0.2 §4 + G15)
// ---------------------------------------------------------------------------

/** The single terminal state (G15). */
export const TERMINAL_STATE: TaskerState = "CLOSED";

/** States in which an escalation (overlay) may be raised — released, non-terminal (G3). TRIAGE only post-dispatch. */
export const ESCALATABLE_STATES: readonly TaskerState[] = [
  "ASSIGNED",
  "CLARIFICATION",
  "IN_WORK",
  "IN_COORDINATION",
  "AWAITING_APPROVAL",
  "TRIAGE",
];

/**
 * Dispositions that may NEVER close a tasker (N2). Also a DB CHECK.
 * Reassigned and Returned for Rework because forwarding is not closure.
 * Concurred and Nonconcurred because a gate decision cannot close the tasker.
 * With these four refused, nothing remains that can be added, so the approved set is fixed (N1).
 */
export const NEVER_CLOSING: readonly DispositionType[] = [
  "reassigned",
  "returned_for_rework",
  "concurred",
  "nonconcurred",
];

const DEFAULT_CLOSING: DispositionType[] = ["completed", "submitted", "no_equity_validated", "cancelled_obe"];

/**
 * Closing set (approved, fixed). Changes are add-only through config (N1). Removing a type
 * requires a non-closing target in `nonClosingTargets`; validateConfig() refuses a removal
 * without one, an empty set, and any NEVER_CLOSING type. All 8 dispositions are recorded
 * immutably; only these move the tasker to CLOSED.
 * Override with MF_CLOSING_DISPOSITIONS=completed,submitted,... — validated at startup.
 */
export const closingDispositions: readonly DispositionType[] =
  (process.env.MF_CLOSING_DISPOSITIONS?.split(",").map((x) => x.trim()) as DispositionType[] | undefined) ??
  DEFAULT_CLOSING;

export const isClosingDisposition = (t: DispositionType): boolean => closingDispositions.includes(t);

/**
 * Non-closing target state per disposition (spec v0.2 §4.1). null = gate-level only
 * (tasker state unchanged unless the lifecycle table says otherwise).
 * A type REMOVED from the closing set must have a non-closing target here, or
 * validateConfig() refuses to start (see proposal v0.2 conflict N1).
 */
export const nonClosingTargets: Partial<Record<DispositionType, TaskerState | null>> = {
  concurred: null, // gate → concurred; tasker state unchanged (N5)
  nonconcurred: "IN_WORK", // only when the tasker is IN_COORDINATION; otherwise the state stays (N5)
  reassigned: "ASSIGNED",
  returned_for_rework: "IN_WORK",
};

/**
 * States from which Reassigned is allowed (N4). Same set as an escalation can be raised.
 * The tasker returns to ASSIGNED. Open gates and their decisions are kept.
 */
export const REASSIGNABLE_STATES: readonly TaskerState[] = [
  "ASSIGNED",
  "CLARIFICATION",
  "IN_WORK",
  "IN_COORDINATION",
  "AWAITING_APPROVAL",
  "TRIAGE",
];

/** N3 / N6 audit event names. Payloads are enforced by a DB trigger. */
export const AUDIT_EVENTS = {
  elevatedWithNonconcurrence: "tasker.elevated_with_nonconcurrence",
  escalationJoined: "escalation.joined",
} as const;

/** Completed vs Submitted is decided by tasker.transmit_to_higher_hq at sign time (G17). */
export const signDisposition = (transmitToHigherHq: boolean): DispositionType =>
  transmitToHigherHq ? "submitted" : "completed";

/** Rationale / redirection rules (spec §4.1; see proposal gap G1 on `concurred`). */
export const dispositionFieldRules: Record<
  DispositionType,
  { rationale: "required" | "optional"; redirect: "required" | "recommended" | "none" }
> = {
  completed: { rationale: "optional", redirect: "none" },
  submitted: { rationale: "optional", redirect: "none" },
  concurred: { rationale: "optional", redirect: "none" }, // G1 ruling: optional (comment field still available)
  nonconcurred: { rationale: "required", redirect: "none" },
  no_equity_validated: { rationale: "required", redirect: "recommended" },
  reassigned: { rationale: "required", redirect: "required" },
  cancelled_obe: { rationale: "required", redirect: "none" },
  returned_for_rework: { rationale: "required", redirect: "none" },
};

// ---------------------------------------------------------------------------
// AI drafting (spec v0.2 G19 — APPROVED by Ryan 2026-10-10)
//   • Commercial model allowed ONLY in the public demo deployment, synthetic data only,
//     labeled "Demo, not accredited". Off everywhere else (local, preview, any other env).
//   • Template stand-in is the default and the fallback (also on gateway error).
//   • Every artifact records provider + model (DB CHECKs).
// ---------------------------------------------------------------------------

/** Exact stamp, mandated by charter §11.3. Also pinned by a DB CHECK constraint. */
export const AI_DRAFT_STAMP = "[DRAFT – AI-GENERATED ASSISTANCE – REQUIRES AO VERIFICATION]" as const;

export type AiProviderId = "template" | "vercel_ai_gateway";

export const TEMPLATE_MODEL_ID = "missionflow-template-v1";
export const AI_DEMO_LABEL = "Demo, not accredited — synthetic data only";

/** In-app spend caps (N11). The env flag is the kill switch; these caps fall back to the template. */
export const AI_SPEND_CAPS = {
  draftsPerSessionPerHour: 10,
  draftsPerDay: 200,
} as const;

export type AiSpendUsage = {
  sessionDraftsThisHour: number;
  globalDraftsToday: number;
};

/**
 * Builder's pick (proposal v0.2 §8): Vercel AI Gateway, model `openai/gpt-5.4-nano` as primary,
 * `anthropic/claude-haiku-4.5` as the gateway fallback. Env may choose ONLY among these;
 * adding a model is a reviewed code change (it changes what Ryan approved).
 */
export const APPROVED_GATEWAY_MODELS = ["openai/gpt-5.4-nano", "anthropic/claude-haiku-4.5"] as const;
export type ApprovedGatewayModel = (typeof APPROVED_GATEWAY_MODELS)[number];
const isApproved = (m: string): m is ApprovedGatewayModel => (APPROVED_GATEWAY_MODELS as readonly string[]).includes(m);

/** The ONE deployment where the commercial model may run. Set MF_DEPLOYMENT=public-demo only there. */
export const PUBLIC_DEMO_DEPLOYMENT = "public-demo";

export const flags = {
  /** Master switch; still requires the public-demo production deployment. */
  aiCommercialEnabled: process.env.MF_AI_COMMERCIAL_ENABLED === "true",
  aiGatewayModel: process.env.MF_AI_GATEWAY_MODEL ?? "openai/gpt-5.4-nano",
  aiGatewayFallbackModels: (process.env.MF_AI_GATEWAY_FALLBACK_MODELS ?? "anthropic/claude-haiku-4.5")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  /** AI may suggest match keys; a human must accept them (spec §2.3). Never routes on its own. */
  aiMatchKeySuggestions: process.env.MF_AI_MATCH_SUGGESTIONS !== "false",
  /** Allow the admin "Reset demo data" action (G10: allowed in the demo deployment). */
  demoResetEnabled: process.env.MF_DEMO_RESET_ENABLED !== "false",
} as const;

export type AiResolution =
  | { provider: "template"; model: typeof TEMPLATE_MODEL_ID; reason: string; notice?: string }
  | { provider: "vercel_ai_gateway"; model: ApprovedGatewayModel; fallbacks: ApprovedGatewayModel[]; label: string };

/** Any gateway error, or a spend cap, uses the template and can carry a notice for the UI. */
export function fallbackToTemplate(reason: string, notice?: string): Extract<AiResolution, { provider: "template" }> {
  return { provider: "template", model: TEMPLATE_MODEL_ID, reason, notice };
}

/**
 * If the gateway was selected but this session or the day is over its cap, use the template
 * and attach a visible notice. Caps never apply to an already-template resolution.
 */
export function enforceAiSpendCaps(resolution: AiResolution, usage: AiSpendUsage): AiResolution {
  if (resolution.provider !== "vercel_ai_gateway") return resolution;
  if (usage.sessionDraftsThisHour >= AI_SPEND_CAPS.draftsPerSessionPerHour) {
    return fallbackToTemplate(
      "session hourly cap",
      "Commercial drafting is paused for this session (10 drafts per hour). The template was used instead.",
    );
  }
  if (usage.globalDraftsToday >= AI_SPEND_CAPS.draftsPerDay) {
    return fallbackToTemplate(
      "daily cap",
      "Commercial drafting is paused for today (200 drafts). The template was used instead.",
    );
  }
  return resolution;
}

/**
 * Decide which provider may run. Pure: pass env explicitly in tests.
 * Commercial only when ALL hold: master switch on, MF_DEPLOYMENT=public-demo,
 * VERCEL_ENV=production (never preview/dev/local), approved model. Synthetic-only input guard
 * is enforced again at call time in core/ai (every input row is_synthetic=true; DB pins it too).
 */
export type AiEnv = {
  MF_AI_COMMERCIAL_ENABLED?: string;
  MF_DEPLOYMENT?: string;
  VERCEL_ENV?: string;
  MF_AI_GATEWAY_MODEL?: string;
  MF_AI_GATEWAY_FALLBACK_MODELS?: string;
};

export function resolveAiProvider(env: AiEnv = process.env as AiEnv): AiResolution {
  const tpl = (reason: string): AiResolution => ({ provider: "template", model: TEMPLATE_MODEL_ID, reason });
  if (env.MF_AI_COMMERCIAL_ENABLED !== "true") return tpl("commercial flag off");
  if (env.MF_DEPLOYMENT !== PUBLIC_DEMO_DEPLOYMENT) return tpl("not the public demo deployment");
  if (env.VERCEL_ENV !== "production") return tpl("not the production public-demo env");
  const model = env.MF_AI_GATEWAY_MODEL ?? "openai/gpt-5.4-nano";
  if (!isApproved(model)) return tpl(`model ${model} not in APPROVED_GATEWAY_MODELS`);
  const fallbacks = (env.MF_AI_GATEWAY_FALLBACK_MODELS ?? "anthropic/claude-haiku-4.5")
    .split(",")
    .map((x) => x.trim())
    .filter((m): m is ApprovedGatewayModel => isApproved(m) && m !== model);
  return { provider: "vercel_ai_gateway", model, fallbacks, label: AI_DEMO_LABEL };
}

// ---------------------------------------------------------------------------
// Business time zone (G18). NEVER use the host/server time zone (Vercel runs in UTC).
// ---------------------------------------------------------------------------

/**
 * Echelon rank (N9). Not the Postgres enum order.
 * haf > majcom > center = naf > wing > group > squadron > flight.
 * "Higher" means a strictly greater rank, so equal ranks do not transmit upward.
 */
export const ECHELON_RANK = {
  haf: 7,
  majcom: 6,
  center: 5,
  naf: 5,
  wing: 4,
  group: 3,
  squadron: 2,
  flight: 1,
} as const;
export type Echelon = keyof typeof ECHELON_RANK;

/** G17 default: true only when the originator org outranks the approver org. */
export function defaultTransmitToHigherHq(originator: Echelon, approver: Echelon): boolean {
  return ECHELON_RANK[originator] > ECHELON_RANK[approver];
}

export const BUSINESS_TZ = process.env.MF_BUSINESS_TZ ?? "America/Chicago";

/** "Today" as an ISO date (YYYY-MM-DD) in the business time zone. Inject `now` for tests. */
export function businessToday(now: Date = new Date(), tz: string = BUSINESS_TZ): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** §10.1 conflict rule: latest AO assignment date strictly before business-today. */
export const isSuspenseConflict = (latestAoAssignmentDate: string, now: Date = new Date()): boolean =>
  latestAoAssignmentDate < businessToday(now);

// ---------------------------------------------------------------------------
// Suspense planning (spec §10; AO-window <35% warns only — approved)
// ---------------------------------------------------------------------------

export const suspense = {
  defaultContingencyBufferDays: Number(process.env.MF_DEFAULT_BUFFER_DAYS ?? 2),
  /** OBJ-4: AO window < this fraction → non-blocking warning only. */
  aoWindowWarnBelowPct: 0.35,
  /** Charter §10.2 30-business-day model, used when a registry entry has no profile. */
  standardModel: [
    { stage: "ao_drafting", business_days: 10 },
    { stage: "sme_coordination", business_days: 4 },
    { stage: "unit_qc", business_days: 3 },
    { stage: "wing_center_review", business_days: 3 },
    { stage: "majcom_consolidation", business_days: 3 },
    { stage: "haf_review", business_days: 3 },
    { stage: "contingency_buffer", business_days: 4 },
  ],
  triageSlaMinutes: 120, // §9.2 Step 6 "< 2 hours"
};

// ---------------------------------------------------------------------------
// Registry matching (spec §2.3) — fixed rules engine, tunable weights only
// ---------------------------------------------------------------------------

export const matching = {
  portfolioMatchScore: 50,
  keywordOverlapMaxScore: 30,
  orgIdSpecificityScore: 20,
  echelonSpecificityScore: 10,
  clearMarginMin: 20,
  validationCycleDays: { quarterly: 92 },
};

// ---------------------------------------------------------------------------
// Demo auth (spec §3.4; no passcode-free browse mode in MVP per spec v0.2 §8 item 8)
// ---------------------------------------------------------------------------

export const auth = {
  /** Shared demo passcode. Must be set; app refuses to start in demo mode without it. */
  demoPasscodeEnv: "DEMO_PASSCODE",
  sessionSecretEnv: "SESSION_SECRET",
  syntheticBanner: "SYNTHETIC DEMO DATA – NOT FOR OPERATIONAL USE",
  allowedEmailDomain: "example.test",
};

// ---------------------------------------------------------------------------
// Startup validation (G15 hard rule + sanity)
// ---------------------------------------------------------------------------

export class ConfigError extends Error {}

export function validateConfig(closing: readonly DispositionType[] = closingDispositions): void {
  for (const t of closing) {
    if (!(DISPOSITION_TYPES as readonly string[]).includes(t)) throw new ConfigError(`Unknown disposition in closing set: ${t}`);
    if (NEVER_CLOSING.includes(t))
      throw new ConfigError(`"${t}" can never close a tasker (charter §8.1 No Closure via Forwarding; spec v0.2 G15)`);
  }
  if (closing.length === 0) throw new ConfigError("Closing set is empty: no tasker could ever close");
  for (const t of DISPOSITION_TYPES)
    if (!closing.includes(t) && !(t in nonClosingTargets))
      throw new ConfigError(`"${t}" removed from closing set but has no non-closing target state defined`);
  try {
    businessToday(new Date(), BUSINESS_TZ);
  } catch {
    throw new ConfigError(`MF_BUSINESS_TZ is not a valid IANA time zone: ${BUSINESS_TZ}`);
  }
}
