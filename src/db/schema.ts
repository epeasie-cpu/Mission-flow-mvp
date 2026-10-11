/**
 * MissionFlow — shared-core Drizzle schema.
 * Applies the shared-core rulings through v0.3: G3 escalation overlay, G11 gate rounds,
 * G15 single CLOSED state, G17 transmit_to_higher_hq, G9 submitted_for_release_at,
 * G10 chain epoch, plus N2–N5, N7, N9, and N10.
 *
 * Maps to shared-core-spec-v0.2.md §2 (data model), §4 (dispositions/state),
 * §5 (audit log), §10 (suspense), §11 (AI). Section refs in comments are SPEC
 * sections unless prefixed "charter".
 *
 * Things deliberately NOT encoded here (they live in src/config/missionflow.config.ts):
 *   - which task category is the pilot
 *   - which dispositions close a tasker
 *   - AI provider selection / feature flags
 *
 * Immutability (append-only) triggers, the audit hash-chain trigger, and DB role
 * grants are raw SQL in db/sql/0001_core_guards.sql (Drizzle cannot express triggers).
 *
 * Synthetic data only: every business table carries is_synthetic, pinned TRUE by
 * a CHECK constraint for the MVP.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AI_DRAFT_STAMP,
  DISPOSITION_TYPES,
  TASK_CATEGORIES,
  TASKER_STATES,
} from "../config/missionflow.config";

// ---------------------------------------------------------------------------
// Shared column helpers (spec §2 conventions)
// ---------------------------------------------------------------------------

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const isSynthetic = () => boolean("is_synthetic").notNull().default(true);
const syntheticCheck = (table: string, col: AnyPgColumn) =>
  check(`${table}_is_synthetic_ck`, sql`${col} = true`);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const echelonEnum = pgEnum("echelon", ["haf", "majcom", "center", "naf", "wing", "group", "squadron", "flight"]); // §2.1; rank is ECHELON_RANK in config, not enum order (N9)
export const availabilityEnum = pgEnum("user_availability", ["available", "tdy", "deployed", "leave", "reassigned"]); // §2.2 User
export const globalRoleEnum = pgEnum("global_role", [
  "enterprise_participant",
  "functional_owner",
  "supervisor",
  "task_controller",
  "tasking_authority",
  "approver",
  "system_admin",
]); // §2.2 RoleGrant, §3.1
export const taskerRoleEnum = pgEnum("tasker_role", [
  "originator",
  "accountable_product_owner",
  "ao_primary",
  "ao_alternate",
  "sme_contributor",
  "coordinator",
  "approver",
  "awareness",
]); // §2.2 TaskerAssignment
export const assignmentSourceEnum = pgEnum("assignment_source", [
  "registry_match",
  "manual",
  "alternate_failover",
  "reassignment",
]);
export const taskCategoryEnum = pgEnum("task_category", TASK_CATEGORIES); // charter §13; pilot gating in config
export const priorityEnum = pgEnum("tasker_priority", ["routine", "priority", "flash_urgent"]);
export const taskerStateEnum = pgEnum("tasker_state", TASKER_STATES); // v0.2 §4.3 (no ESCALATED; single CLOSED)
export const registryStatusEnum = pgEnum("registry_status", ["draft", "active", "expired", "retired"]);
export const validationCycleEnum = pgEnum("validation_cycle", ["quarterly"]);
export const smeStatusEnum = pgEnum("sme_status", ["requested", "submitted", "declined", "withdrawn"]);
export const gateKindEnum = pgEnum("gate_kind", ["coordination", "approval"]);
export const gateSourceEnum = pgEnum("gate_source", ["registry_mandatory", "tasking_authority", "ao_requested"]);
export const gateStatusEnum = pgEnum("gate_status", [
  "pending",
  "open",
  "concurred",
  "nonconcurred",
  "endorsed",
  "approved",
  "disapproved",
  "signed",
  "auto_closed",
]);
export const dispositionTypeEnum = pgEnum("disposition_type", DISPOSITION_TYPES); // §4, exactly 8
export const correctiveOptionEnum = pgEnum("corrective_option", [
  "a_extension",
  "b_descope",
  "c_flash_urgent",
  "d_augment",
  "e_emergency_workflow",
]); // charter §10.3
export const enclaveEnum = pgEnum("enclave", ["original", "supporting", "draft", "coordination", "final"]); // charter §12
export const authorTypeEnum = pgEnum("author_type", ["human", "ai"]);
export const aiKindEnum = pgEnum("ai_kind", [
  "requirement_summary",
  "plain_language_summary",
  "work_breakdown",
  "clarifying_questions",
  "template",
  "first_draft",
  "coordination_memo",
  "crm",
  "redline_diff",
  "escalation_warning",
]); // charter §11.2
export const aiVerificationDecisionEnum = pgEnum("ai_verification_decision", ["verified", "rejected"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "system", "ai"]); // §5.1
export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "delivered", "failed"]);

// ---------------------------------------------------------------------------
// §2.1 Supporting entities
// ---------------------------------------------------------------------------

export const org = pgTable(
  "org",
  {
    id: id(),
    name: text("name").notNull(),
    shortCode: text("short_code").notNull().unique(),
    echelon: echelonEnum("echelon").notNull(),
    parentOrgId: uuid("parent_org_id").references((): AnyPgColumn => org.id),
    missionCodes: text("mission_codes").array().notNull().default(sql`'{}'::text[]`),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [syntheticCheck("org", t.isSynthetic), index("org_parent_idx").on(t.parentOrgId)],
);

export const appUser = pgTable(
  "app_user", // "user" is a reserved word in Postgres
  {
    id: id(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull().unique(),
    orgId: uuid("org_id").notNull().references(() => org.id),
    billetLabel: text("billet_label"), // shown on persona picker (§3.4)
    availability: availabilityEnum("availability").notNull().default("available"),
    isActive: boolean("is_active").notNull().default(true),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("app_user", t.isSynthetic),
    check("app_user_email_domain_ck", sql`${t.email} like '%@example.test'`),
  ],
);

export const position = pgTable(
  "position",
  {
    id: id(),
    title: text("title").notNull(),
    orgId: uuid("org_id").notNull().references(() => org.id),
    incumbentUserId: uuid("incumbent_user_id").references(() => appUser.id),
    alternateUserId: uuid("alternate_user_id").references(() => appUser.id), // see gap G7 (two alternate sources)
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [syntheticCheck("position", t.isSynthetic)],
);

export const roleGrant = pgTable(
  "role_grant",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => appUser.id),
    role: globalRoleEnum("role").notNull(),
    scopeOrgId: uuid("scope_org_id").references(() => org.id), // null = enterprise-wide
    portfolio: text("portfolio"), // Functional Owner scope
    grantedBy: uuid("granted_by").notNull().references(() => appUser.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }), // revoke only; never delete
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [syntheticCheck("role_grant", t.isSynthetic), index("role_grant_user_idx").on(t.userId)],
);

/** Referenced by spec (§2.2 deliverable_format, §9.1 standard_template_id) but not defined there — gap G5. */
export const template = pgTable(
  "template",
  {
    id: id(),
    code: text("code").notNull().unique(), // e.g. "AWARD-1206-BBP"
    name: text("name").notNull(),
    category: taskCategoryEnum("category").notNull(),
    bodyMd: text("body_md").notNull(), // also feeds the template AI stand-in
    version: integer("version").notNull().default(1),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [syntheticCheck("template", t.isSynthetic)],
);

/** Business-day calendar (§2.2 Suspense plan, "configurable holiday table"). */
export const holiday = pgTable("holiday", {
  day: date("day").primaryKey(),
  label: text("label").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// §2.2 Responsibility Registry entry (charter §9.1)
// ---------------------------------------------------------------------------

export type OrgScope = { echelons: string[]; org_ids: string[] };
export type MandatoryCoordination = { office: string; position_id: string; condition?: string; default_justification?: string }[];
export type TimelineProfile = { stage: string; business_days: number }[];
export type ApplicabilityCriteria = { mission_codes_any: string[] };

export const registryEntry = pgTable(
  "registry_entry",
  {
    id: id(),
    responsibilityId: text("responsibility_id").notNull().unique(),
    missionFunction: text("mission_function").notNull(),
    portfolio: text("portfolio").notNull(),
    orgScope: jsonb("org_scope").$type<OrgScope>().notNull(),
    accountablePositionId: uuid("accountable_position_id").notNull().references(() => position.id),
    responsiblePositionId: uuid("responsible_position_id").notNull().references(() => position.id),
    designatedAlternatePositionId: uuid("designated_alternate_position_id").references(() => position.id),
    designatedAlternateUserId: uuid("designated_alternate_user_id").references(() => appUser.id),
    supervisoryPositionId: uuid("supervisory_position_id").notNull().references(() => position.id),
    mandatoryCoordination: jsonb("mandatory_coordination").$type<MandatoryCoordination>().notNull().default([]),
    designatedApproverPositionId: uuid("designated_approver_position_id").notNull().references(() => position.id),
    standardTemplateId: uuid("standard_template_id").references(() => template.id),
    baselineTimelineProfile: jsonb("baseline_timeline_profile").$type<TimelineProfile>().notNull(),
    applicabilityCriteria: jsonb("applicability_criteria").$type<ApplicabilityCriteria>(),
    validationCycle: validationCycleEnum("validation_cycle").notNull().default("quarterly"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    validatedBy: uuid("validated_by").references(() => appUser.id),
    functionalOwnerUserId: uuid("functional_owner_user_id").notNull().references(() => appUser.id),
    taskCategories: taskCategoryEnum("task_categories").array().notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    status: registryStatusEnum("status").notNull().default("draft"),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    syntheticCheck("registry_entry", t.isSynthetic),
    check(
      "registry_entry_alternate_ck",
      sql`${t.designatedAlternatePositionId} is not null or ${t.designatedAlternateUserId} is not null`,
    ),
    check(
      "registry_entry_active_validated_ck",
      sql`${t.status} <> 'active' or (${t.lastValidatedAt} is not null and ${t.validatedBy} is not null)`,
    ),
    index("registry_entry_match_idx").on(t.status, t.missionFunction),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 Tasker
// ---------------------------------------------------------------------------

/** N3: gates attached when work is forwarded to the Approver with a nonconcurrence. */
export type ElevatedNonconcurrence = {
  gate_ids: string[];
  gate_rounds: number[];
  rationale: string;
};

export type MatchSnapshot = {
  candidates: { entryId: string; score: number; reasons: string[] }[];
  chosen?: string;
  confidence: "clear" | "ambiguous" | "none";
  resolved: Record<string, unknown>;
  failoverApplied: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
};

export const tasker = pgTable(
  "tasker",
  {
    id: id(),
    ref: text("ref").notNull().unique(), // MF-2026-0001
    parentTaskerId: uuid("parent_tasker_id").references((): AnyPgColumn => tasker.id), // RFI fan-out later (§6); unused in MVP
    title: text("title").notNull(),
    category: taskCategoryEnum("category").notNull(),
    missionFunction: text("mission_function").notNull(),
    portfolio: text("portfolio"),
    targetOrgId: uuid("target_org_id").notNull().references(() => org.id),
    requirement: text("requirement").notNull(),
    deliverableFormat: text("deliverable_format").notNull(),
    deliverableTemplateId: uuid("deliverable_template_id").references(() => template.id),
    deliverableCriteria: text("deliverable_criteria"),
    externalSuspense: date("external_suspense").notNull(),
    priority: priorityEnum("priority").notNull().default("routine"),
    state: taskerStateEnum("state").notNull().default("DRAFT"), // only src/core/lifecycle writes this
    registryEntryId: uuid("registry_entry_id").references(() => registryEntry.id),
    matchSnapshot: jsonb("match_snapshot").$type<MatchSnapshot>(),
    currentSuspensePlanId: uuid("current_suspense_plan_id").references((): AnyPgColumn => suspensePlan.id),
    originatorId: uuid("originator_id").notNull().references(() => appUser.id),
    taskingAuthorityId: uuid("tasking_authority_id").references(() => appUser.id),
    /** G17: TA sets before release. Default is true only when the originator org's ECHELON_RANK is strictly above the approver org (N9). Sign → Submitted if true, else Completed. */
    transmitToHigherHq: boolean("transmit_to_higher_hq"),
    submittedForReleaseAt: timestamp("submitted_for_release_at", { withTimezone: true }), // G9: time-to-correct-AO start
    releasedAt: timestamp("released_at", { withTimezone: true }), // AO execution clock start (charter §10.3)
    acceptedAt: timestamp("accepted_at", { withTimezone: true }), // current AO only; overwritten on reassignment (per-AO history is tasker_assignment.accepted_at, N7)
    firstViewedByAoAt: timestamp("first_viewed_by_ao_at", { withTimezone: true }),
    triageEnteredAt: timestamp("triage_entered_at", { withTimezone: true }), // < 2h SLA (charter §9.2)
    closedAt: timestamp("closed_at", { withTimezone: true }),
    reworkCount: integer("rework_count").notNull().default(0),
    finalDispositionId: uuid("final_disposition_id").references((): AnyPgColumn => disposition.id),
    closedDispositionType: dispositionTypeEnum("closed_disposition_type"), // G15: denormalized, indexed; state is the single CLOSED
    /** N3: which gates were attached on elevate-to-Approver. Null when none are attached. */
    elevatedNonconcurrence: jsonb("elevated_nonconcurrence").$type<ElevatedNonconcurrence>(),
    rowVersion: integer("row_version").notNull().default(1), // optimistic lock
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    syntheticCheck("tasker", t.isSynthetic),
    // Release-time requirements (spec §2.2 "Req at release")
    check(
      "tasker_released_fields_ck",
      sql`${t.releasedAt} is null or (${t.taskingAuthorityId} is not null and ${t.currentSuspensePlanId} is not null and ${t.transmitToHigherHq} is not null and ${t.submittedForReleaseAt} is not null)`,
    ),
    // G15: CLOSED ⇔ closed_disposition_type + final_disposition_id + closed_at all set
    check(
      "tasker_closed_fields_ck",
      sql`(${t.state} = 'CLOSED') = (${t.closedDispositionType} is not null and ${t.finalDispositionId} is not null and ${t.closedAt} is not null)`,
    ),
    // N2: forwarding and gate outcomes never close a tasker. Backstop for validateConfig().
    check(
      "tasker_closed_type_not_forwarding_ck",
      sql`${t.closedDispositionType} not in ('reassigned','returned_for_rework','concurred','nonconcurred')`,
    ),
    check(
      "tasker_elevated_nonconcurrence_ck",
      sql`${t.elevatedNonconcurrence} is null or (
        jsonb_typeof(${t.elevatedNonconcurrence}->'gate_ids') = 'array'
        and jsonb_typeof(${t.elevatedNonconcurrence}->'gate_rounds') = 'array'
        and jsonb_array_length(${t.elevatedNonconcurrence}->'gate_ids') > 0
        and jsonb_array_length(${t.elevatedNonconcurrence}->'gate_ids') = jsonb_array_length(${t.elevatedNonconcurrence}->'gate_rounds')
        and coalesce(length(trim(${t.elevatedNonconcurrence}->>'rationale')), 0) > 0
      )`,
    ),
    check(
      "tasker_submitted_for_release_ck",
      sql`${t.state} in ('DRAFT','CLOSED') or ${t.submittedForReleaseAt} is not null`,
    ),
    index("tasker_state_idx").on(t.state),
    index("tasker_closed_type_idx").on(t.closedDispositionType),
    index("tasker_target_org_idx").on(t.targetOrgId),
  ],
);

/** AI-suggested match keys awaiting human acceptance (§2.3 "unaccepted chips"). */
export const matchKeySuggestion = pgTable("match_key_suggestion", {
  id: id(),
  taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
  field: text("field").notNull(), // mission_function | portfolio | keywords | target_org_id
  suggestedValue: text("suggested_value").notNull(),
  aiArtifactId: uuid("ai_artifact_id").references((): AnyPgColumn => aiArtifact.id),
  acceptedBy: uuid("accepted_by").references(() => appUser.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  isSynthetic: isSynthetic(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// §2.2 TaskerAssignment
// ---------------------------------------------------------------------------

export const taskerAssignment = pgTable(
  "tasker_assignment",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    userId: uuid("user_id").notNull().references(() => appUser.id),
    positionId: uuid("position_id").references(() => position.id),
    role: taskerRoleEnum("role").notNull(),
    source: assignmentSourceEnum("source").notNull(),
    rationale: text("rationale"),
    assignedBy: uuid("assigned_by").notNull().references(() => appUser.id), // never AI (§11.3)
    active: boolean("active").notNull().default(true),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }), // N7: set once for this AO assignment
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("tasker_assignment", t.isSynthetic),
    check(
      "tasker_assignment_rationale_ck",
      sql`${t.source} not in ('manual','reassignment') or coalesce(length(trim(${t.rationale})),0) > 0`,
    ), // §8.1 Mandatory Handoff Rationale
    uniqueIndex("tasker_one_active_apo_uq")
      .on(t.taskerId)
      .where(sql`${t.role} = 'accountable_product_owner' and ${t.active}`), // §8.1 exactly one owner
    uniqueIndex("tasker_one_active_ao_uq").on(t.taskerId).where(sql`${t.role} = 'ao_primary' and ${t.active}`),
    index("tasker_assignment_user_idx").on(t.userId, t.active),
  ],
);

// ---------------------------------------------------------------------------
// Clarification (§4.2 / charter §6.1) — needed by requestClarification/answerClarification; gap G6
// ---------------------------------------------------------------------------

export const clarification = pgTable("clarification", {
  id: id(),
  taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
  askedBy: uuid("asked_by").notNull().references(() => appUser.id),
  question: text("question").notNull(),
  answeredBy: uuid("answered_by").references(() => appUser.id),
  answer: text("answer"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  isSynthetic: isSynthetic(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Escalation overlay (spec v0.2 §4.2, G3) — NOT a tasker state. Work continues while open.
// Raise: AO/Alt, APO, Supervisor, Task Controller. Resolve: Supervisor or TA. Auto-closed by
// the system when the tasker closes. At most one open per tasker (N6). A second raiser
// joins via an escalation.joined audit event; this table does not gain a second open row.
// ---------------------------------------------------------------------------

export const escalation = pgTable(
  "escalation",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    raisedBy: uuid("raised_by").notNull().references(() => appUser.id), // human only; AI may only warn (§11.2)
    raisedByRole: text("raised_by_role").notNull(),
    reason: text("reason").notNull(),
    aiWarningArtifactId: uuid("ai_warning_artifact_id").references((): AnyPgColumn => aiArtifact.id), // optional AI "predictive escalation" that prompted it
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: uuid("resolved_by").references(() => appUser.id), // null only when auto_closed
    resolution: text("resolution"),
    autoClosed: boolean("auto_closed").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("escalation", t.isSynthetic),
    check("escalation_reason_ck", sql`length(trim(${t.reason})) > 0`),
    check(
      "escalation_resolution_ck",
      sql`${t.resolvedAt} is null or (coalesce(length(trim(${t.resolution})),0) > 0 and (${t.resolvedBy} is not null or ${t.autoClosed}))`,
    ),
    check("escalation_auto_closed_ck", sql`not ${t.autoClosed} or (${t.resolvedAt} is not null and ${t.resolvedBy} is null)`),
    uniqueIndex("escalation_one_open_uq").on(t.taskerId).where(sql`${t.resolvedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 Suspense plan (charter §10) — immutable snapshots
// ---------------------------------------------------------------------------

export type SuspenseStage = { name: string; business_days: number; start: string; end: string };

export const suspensePlan = pgTable(
  "suspense_plan",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references((): AnyPgColumn => tasker.id),
    version: integer("version").notNull(),
    externalSuspense: date("external_suspense").notNull(),
    stages: jsonb("stages").$type<SuspenseStage[]>().notNull(),
    contingencyBufferDays: integer("contingency_buffer_days").notNull(),
    latestAoAssignmentDate: date("latest_ao_assignment_date").notNull(),
    aoWindowPct: numeric("ao_window_pct", { precision: 5, scale: 4 }).notNull(),
    conflict: boolean("conflict").notNull(),
    computedBy: uuid("computed_by").references(() => appUser.id), // null = system recompute
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("suspense_plan", t.isSynthetic),
    uniqueIndex("suspense_plan_version_uq").on(t.taskerId, t.version),
  ],
);

/**
 * Corrective-option resolution of a conflicted plan (charter §10.3).
 * Split out of suspense_plan so that table stays fully write-once (gap G2:
 * spec puts corrective_option on the immutable plan row).
 */
export const suspenseResolution = pgTable(
  "suspense_resolution",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    conflictedPlanId: uuid("conflicted_plan_id").notNull().references(() => suspensePlan.id),
    resultingPlanId: uuid("resulting_plan_id").references(() => suspensePlan.id), // null for (a) (request only; G4). (a)+(b–e) = two rows
    option: correctiveOptionEnum("option").notNull(),
    rationale: text("rationale").notNull(),
    resolvedBy: uuid("resolved_by").notNull().references(() => appUser.id), // human only (charter §6.2)
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("suspense_resolution", t.isSynthetic),
    check("suspense_resolution_rationale_ck", sql`length(trim(${t.rationale})) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 SME input
// ---------------------------------------------------------------------------

export const smeInput = pgTable(
  "sme_input",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    requestedBy: uuid("requested_by").notNull().references(() => appUser.id),
    smeUserId: uuid("sme_user_id").notNull().references(() => appUser.id),
    ask: text("ask").notNull(),
    dueDate: date("due_date"),
    status: smeStatusEnum("status").notNull().default("requested"),
    response: text("response"),
    attachmentIds: uuid("attachment_ids").array().notNull().default(sql`'{}'::uuid[]`),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("sme_input", t.isSynthetic),
    check("sme_input_decline_ck", sql`${t.status} <> 'declined' or coalesce(length(trim(${t.declineReason})),0) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 Coordination / approval gate
// ---------------------------------------------------------------------------

export const gate = pgTable(
  "gate",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    kind: gateKindEnum("kind").notNull(),
    sequence: integer("sequence").notNull(), // parallel gates share a number
    officeLabel: text("office_label").notNull(),
    positionId: uuid("position_id").references(() => position.id),
    assigneeUserId: uuid("assignee_user_id").references(() => appUser.id), // resolved at open
    source: gateSourceEnum("source").notNull(),
    condition: text("condition"), // e.g. "if funded" (TA checkbox, §2.3)
    round: integer("round").notNull().default(1), // G11: +1 each time a nonconcurred (or AO-re-requested) gate reopens
    /** G11: the frozen coordination-package version this round reviews (decisions bind to it). */
    packageVersionId: uuid("package_version_id").references((): AnyPgColumn => documentVersion.id),
    justification: text("justification").notNull(), // §8.1 Explicit Equity Justification
    blocking: boolean("blocking").notNull().default(true),
    dueDate: date("due_date").notNull(),
    status: gateStatusEnum("status").notNull().default("pending"),
    decisionComment: text("decision_comment"),
    decidedBy: uuid("decided_by").references(() => appUser.id), // human only
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("gate", t.isSynthetic),
    check("gate_justification_ck", sql`length(trim(${t.justification})) > 0`),
    check(
      "gate_decision_comment_ck",
      sql`${t.status} not in ('nonconcurred','disapproved') or coalesce(length(trim(${t.decisionComment})),0) > 0`,
    ),
    check("gate_assignee_when_open_ck", sql`${t.status} = 'pending' or ${t.assigneeUserId} is not null`),
    check("gate_round_ck", sql`${t.round} >= 1`),
    index("gate_tasker_idx").on(t.taskerId, t.sequence),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 Disposition — immutable (trigger in db/sql/0001_core_guards.sql)
// ---------------------------------------------------------------------------

export const disposition = pgTable(
  "disposition",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references((): AnyPgColumn => tasker.id),
    gateId: uuid("gate_id").references(() => gate.id),
    gateRound: integer("gate_round"), // G11: which round of the gate this decision belongs to
    type: dispositionTypeEnum("type").notNull(),
    appliedBy: uuid("applied_by").notNull().references(() => appUser.id), // human only
    actingRole: text("acting_role").notNull(),
    rationale: text("rationale"),
    redirectToUserId: uuid("redirect_to_user_id").references(() => appUser.id),
    redirectToEntryId: uuid("redirect_to_entry_id").references(() => registryEntry.id),
    fromState: taskerStateEnum("from_state").notNull(),
    toState: taskerStateEnum("to_state").notNull(),
    closesTasker: boolean("closes_tasker").notNull(), // snapshot of config closing set at time of apply (G15)
    correctsDispositionId: uuid("corrects_disposition_id").references((): AnyPgColumn => disposition.id), // corrections are new rows
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("disposition", t.isSynthetic),
    // DB backstop for the rules in config.dispositionFieldRules (app validates first)
    check(
      "disposition_rationale_ck",
      sql`${t.type} in ('completed','submitted','concurred') or coalesce(length(trim(${t.rationale})),0) > 0`,
    ),
    check(
      "disposition_reassigned_redirect_ck",
      sql`${t.type} <> 'reassigned' or ${t.redirectToUserId} is not null or ${t.redirectToEntryId} is not null`,
    ),
    check(
      "disposition_gate_ck",
      sql`${t.type} not in ('concurred','nonconcurred') or (${t.gateId} is not null and ${t.gateRound} is not null)`,
    ),
    // G15 / N2: closes ⇔ lands in CLOSED; forwarding and gate outcomes never close
    check("disposition_closes_state_ck", sql`${t.closesTasker} = (${t.toState} = 'CLOSED')`),
    check(
      "disposition_forwarding_never_closes_ck",
      sql`not ${t.closesTasker} or ${t.type} not in ('reassigned','returned_for_rework','concurred','nonconcurred')`,
    ),
    // N4: Reassigned returns the tasker to ASSIGNED from every state where an escalation can be raised.
    check(
      "disposition_reassigned_states_ck",
      sql`${t.type} <> 'reassigned' or (${t.fromState} in ('ASSIGNED','CLARIFICATION','IN_WORK','IN_COORDINATION','AWAITING_APPROVAL','TRIAGE') and ${t.toState} = 'ASSIGNED')`,
    ),
    // N5: a concur records the gate and does not move the tasker.
    check(
      "disposition_concur_states_ck",
      sql`${t.type} <> 'concurred' or (${t.fromState} = ${t.toState} and ${t.fromState} <> 'CLOSED')`,
    ),
    // N5: nonconcur moves the tasker to IN_WORK only from IN_COORDINATION; elsewhere the state stays put.
    check(
      "disposition_nonconcur_states_ck",
      sql`${t.type} <> 'nonconcurred' or ((${t.fromState} = 'IN_COORDINATION' and ${t.toState} = 'IN_WORK') or (${t.fromState} <> 'IN_COORDINATION' and ${t.fromState} = ${t.toState} and ${t.fromState} <> 'CLOSED'))`,
    ),
    index("disposition_tasker_idx").on(t.taskerId),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 Document / DocumentVersion (charter §12 five enclaves)
// ---------------------------------------------------------------------------

export const document = pgTable(
  "document",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    enclave: enclaveEnum("enclave").notNull(),
    title: text("title").notNull(),
    locked: boolean("locked").notNull().default(false),
    checkedOutBy: uuid("checked_out_by").references(() => appUser.id), // moved here from version (gap G8)
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [syntheticCheck("document", t.isSynthetic), index("document_tasker_idx").on(t.taskerId, t.enclave)],
);

export const documentVersion = pgTable(
  "document_version",
  {
    id: id(),
    documentId: uuid("document_id").notNull().references(() => document.id),
    versionNo: integer("version_no").notNull(),
    bodyMd: text("body_md"),
    blobKey: text("blob_key"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256").notNull(),
    authorType: authorTypeEnum("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => appUser.id),
    aiArtifactId: uuid("ai_artifact_id").references((): AnyPgColumn => aiArtifact.id),
    derivedFromVersionId: uuid("derived_from_version_id").references((): AnyPgColumn => documentVersion.id),
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("document_version", t.isSynthetic),
    uniqueIndex("document_version_no_uq").on(t.documentId, t.versionNo),
    check("document_version_body_ck", sql`${t.bodyMd} is not null or ${t.blobKey} is not null`),
    check("document_version_size_ck", sql`${t.sizeBytes} is null or ${t.sizeBytes} <= 5242880`), // ≤5 MB
    check(
      "document_version_author_ck",
      sql`(${t.authorType} = 'human' and ${t.authorUserId} is not null) or (${t.authorType} = 'ai' and ${t.aiArtifactId} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// §2.2 AI artifact — write-once. Verification columns live only on ai_verification (N8).
// ---------------------------------------------------------------------------

export type AiInputRef = { doc_version_id: string; sha256: string };

export const aiArtifact = pgTable(
  "ai_artifact",
  {
    id: id(),
    taskerId: uuid("tasker_id").notNull().references(() => tasker.id),
    kind: aiKindEnum("kind").notNull(),
    stamp: text("stamp").notNull().default(AI_DRAFT_STAMP),
    content: text("content").notNull(), // rendered with stamp header AND footer
    provider: text("provider").notNull(), // G19: "template" | "vercel_ai_gateway"; recorded on every artifact
    model: text("model").notNull(), // G19: "missionflow-template-v1" or gateway id, e.g. "openai/gpt-5.4-nano" (the model that actually answered)
    deployment: text("deployment").notNull(), // MF_DEPLOYMENT at generation time, e.g. "local" | "public-demo"
    isAccredited: boolean("is_accredited").notNull().default(false), // always false in MVP
    demoLabel: text("demo_label"), // "Demo, not accredited — synthetic data only" when provider is the gateway
    promptTemplateId: text("prompt_template_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputRefs: jsonb("input_refs").$type<AiInputRef[]>().notNull(),
    outputSha256: text("output_sha256").notNull(),
    requestedBy: uuid("requested_by").notNull().references(() => appUser.id), // a human always initiates
    isSynthetic: isSynthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    syntheticCheck("ai_artifact", t.isSynthetic),
    check("ai_artifact_stamp_ck", sql.raw(`stamp = '${AI_DRAFT_STAMP.replace(/'/g, "''")}'`)),
    check(
      "ai_artifact_stamp_rendered_ck",
      sql`starts_with(${t.content}, ${t.stamp}) and right(${t.content}, length(${t.stamp})) = ${t.stamp}`,
    ),
    check("ai_artifact_not_accredited_ck", sql`${t.isAccredited} = false`),
    check("ai_artifact_provider_ck", sql`${t.provider} in ('template','vercel_ai_gateway')`),
    check("ai_artifact_model_ck", sql`length(trim(${t.model})) > 0`),
    check(
      "ai_artifact_commercial_label_ck",
      sql`${t.provider} <> 'vercel_ai_gateway' or coalesce(${t.demoLabel},'') ilike '%not accredited%'`,
    ), // G19: "demo, not accredited" label required
    // G19 (approved): the commercial model may only ever run in the public demo deployment
    check("ai_artifact_gateway_public_demo_ck", sql`${t.provider} <> 'vercel_ai_gateway' or ${t.deployment} = 'public-demo'`),
    index("ai_artifact_tasker_idx").on(t.taskerId),
  ],
);

export const aiVerification = pgTable("ai_verification", {
  id: id(),
  aiArtifactId: uuid("ai_artifact_id").notNull().references(() => aiArtifact.id),
  decision: aiVerificationDecisionEnum("decision").notNull(),
  note: text("note"),
  verifiedBy: uuid("verified_by").notNull().references(() => appUser.id), // AO / acting Alternate only (policy)
  isSynthetic: isSynthetic(),
  createdAt: createdAt(),
});
// Current status = latest ai_verification row per artifact (or "unverified" if none).

// ---------------------------------------------------------------------------
// §5 Audit log — append-only + hash chain (triggers in db/sql/0001_core_guards.sql)
// ---------------------------------------------------------------------------

export const auditEvent = pgTable(
  "audit_event",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: uuid("id").notNull().defaultRandom().unique(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => appUser.id),
    actingRole: text("acting_role"),
    eventType: text("event_type").notNull(), // e.g. "tasker.released"
    taskerId: uuid("tasker_id").references(() => tasker.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    payload: jsonb("payload").notNull().default({}),
    aiArtifactId: uuid("ai_artifact_id").references(() => aiArtifact.id),
    requestId: uuid("request_id").notNull(),
    chainEpoch: integer("chain_epoch").notNull().default(0), // G10: set by trigger from audit_chain_meta; +1 per demo reset
    prevHash: text("prev_hash").notNull(), // set by BEFORE INSERT trigger
    hash: text("hash").notNull(), // set by BEFORE INSERT trigger
  },
  (t) => [
    check("audit_event_actor_ck", sql`(${t.actorType} = 'user') = (${t.actorUserId} is not null)`),
    index("audit_event_tasker_idx").on(t.taskerId, t.seq),
    index("audit_event_type_idx").on(t.eventType),
  ],
);

/** G10: survives demo reset (never truncated) so the audit page can show "chain epoch N". */
export const auditChainMeta = pgTable(
  "audit_chain_meta",
  {
    id: integer("id").primaryKey().default(1),
    currentEpoch: integer("current_epoch").notNull().default(1), // N10
    lastResetAt: timestamp("last_reset_at", { withTimezone: true }),
  },
  (t) => [check("audit_chain_meta_singleton_ck", sql`${t.id} = 1`)],
);

/** Domain-event outbox (§1.5, §5.3.4) — lanes subscribe here, never to each other. */
export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: id(),
    auditSeq: bigint("audit_seq", { mode: "number" }), // correlate with audit_event.seq
    eventType: text("event_type").notNull(), // tasker.released, gate.decided, ...
    taskerId: uuid("tasker_id").references(() => tasker.id),
    payload: jsonb("payload").notNull().default({}),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_pending_idx").on(t.status, t.createdAt)],
);

/** Idempotency ledger for at-least-once subscribers. */
export const outboxDelivery = pgTable(
  "outbox_delivery",
  {
    outboxEventId: uuid("outbox_event_id").notNull().references(() => outboxEvent.id),
    subscriber: text("subscriber").notNull(), // e.g. "oversight.dayOneNotify"
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("outbox_delivery_uq").on(t.outboxEventId, t.subscriber)],
);
