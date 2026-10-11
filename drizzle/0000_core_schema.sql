CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'ai');--> statement-breakpoint
CREATE TYPE "public"."ai_kind" AS ENUM('requirement_summary', 'plain_language_summary', 'work_breakdown', 'clarifying_questions', 'template', 'first_draft', 'coordination_memo', 'crm', 'redline_diff', 'escalation_warning');--> statement-breakpoint
CREATE TYPE "public"."ai_verification_decision" AS ENUM('verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."assignment_source" AS ENUM('registry_match', 'manual', 'alternate_failover', 'reassignment');--> statement-breakpoint
CREATE TYPE "public"."author_type" AS ENUM('human', 'ai');--> statement-breakpoint
CREATE TYPE "public"."user_availability" AS ENUM('available', 'tdy', 'deployed', 'leave', 'reassigned');--> statement-breakpoint
CREATE TYPE "public"."corrective_option" AS ENUM('a_extension', 'b_descope', 'c_flash_urgent', 'd_augment', 'e_emergency_workflow');--> statement-breakpoint
CREATE TYPE "public"."disposition_type" AS ENUM('completed', 'submitted', 'concurred', 'nonconcurred', 'no_equity_validated', 'reassigned', 'cancelled_obe', 'returned_for_rework');--> statement-breakpoint
CREATE TYPE "public"."echelon" AS ENUM('haf', 'majcom', 'center', 'naf', 'wing', 'group', 'squadron', 'flight');--> statement-breakpoint
CREATE TYPE "public"."enclave" AS ENUM('original', 'supporting', 'draft', 'coordination', 'final');--> statement-breakpoint
CREATE TYPE "public"."gate_kind" AS ENUM('coordination', 'approval');--> statement-breakpoint
CREATE TYPE "public"."gate_source" AS ENUM('registry_mandatory', 'tasking_authority', 'ao_requested');--> statement-breakpoint
CREATE TYPE "public"."gate_status" AS ENUM('pending', 'open', 'concurred', 'nonconcurred', 'endorsed', 'approved', 'disapproved', 'signed', 'auto_closed');--> statement-breakpoint
CREATE TYPE "public"."global_role" AS ENUM('enterprise_participant', 'functional_owner', 'supervisor', 'task_controller', 'tasking_authority', 'approver', 'system_admin');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tasker_priority" AS ENUM('routine', 'priority', 'flash_urgent');--> statement-breakpoint
CREATE TYPE "public"."registry_status" AS ENUM('draft', 'active', 'expired', 'retired');--> statement-breakpoint
CREATE TYPE "public"."sme_status" AS ENUM('requested', 'submitted', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."task_category" AS ENUM('awards_package', 'readiness_data_call', 'rfi', 'staff_summary', 'policy_coordination');--> statement-breakpoint
CREATE TYPE "public"."tasker_role" AS ENUM('originator', 'accountable_product_owner', 'ao_primary', 'ao_alternate', 'sme_contributor', 'coordinator', 'approver', 'awareness');--> statement-breakpoint
CREATE TYPE "public"."tasker_state" AS ENUM('DRAFT', 'PENDING_RELEASE', 'SUSPENSE_CONFLICT', 'TRIAGE', 'ASSIGNED', 'CLARIFICATION', 'IN_WORK', 'IN_COORDINATION', 'AWAITING_APPROVAL', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."validation_cycle" AS ENUM('quarterly');--> statement-breakpoint
CREATE TABLE "ai_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"kind" "ai_kind" NOT NULL,
	"stamp" text DEFAULT '[DRAFT – AI-GENERATED ASSISTANCE – REQUIRES AO VERIFICATION]' NOT NULL,
	"content" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"deployment" text NOT NULL,
	"is_accredited" boolean DEFAULT false NOT NULL,
	"demo_label" text,
	"prompt_template_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_refs" jsonb NOT NULL,
	"output_sha256" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_artifact_is_synthetic_ck" CHECK ("ai_artifact"."is_synthetic" = true),
	CONSTRAINT "ai_artifact_stamp_ck" CHECK (stamp = '[DRAFT – AI-GENERATED ASSISTANCE – REQUIRES AO VERIFICATION]'),
	CONSTRAINT "ai_artifact_stamp_rendered_ck" CHECK (starts_with("ai_artifact"."content", "ai_artifact"."stamp") and right("ai_artifact"."content", length("ai_artifact"."stamp")) = "ai_artifact"."stamp"),
	CONSTRAINT "ai_artifact_not_accredited_ck" CHECK ("ai_artifact"."is_accredited" = false),
	CONSTRAINT "ai_artifact_provider_ck" CHECK ("ai_artifact"."provider" in ('template','vercel_ai_gateway')),
	CONSTRAINT "ai_artifact_model_ck" CHECK (length(trim("ai_artifact"."model")) > 0),
	CONSTRAINT "ai_artifact_commercial_label_ck" CHECK ("ai_artifact"."provider" <> 'vercel_ai_gateway' or coalesce("ai_artifact"."demo_label",'') ilike '%not accredited%'),
	CONSTRAINT "ai_artifact_gateway_public_demo_ck" CHECK ("ai_artifact"."provider" <> 'vercel_ai_gateway' or "ai_artifact"."deployment" = 'public-demo')
);
--> statement-breakpoint
CREATE TABLE "ai_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ai_artifact_id" uuid NOT NULL,
	"decision" "ai_verification_decision" NOT NULL,
	"note" text,
	"verified_by" uuid NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"org_id" uuid NOT NULL,
	"billet_label" text,
	"availability" "user_availability" DEFAULT 'available' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email"),
	CONSTRAINT "app_user_is_synthetic_ck" CHECK ("app_user"."is_synthetic" = true),
	CONSTRAINT "app_user_email_domain_ck" CHECK ("app_user"."email" like '%@example.test')
);
--> statement-breakpoint
CREATE TABLE "audit_chain_meta" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"current_epoch" integer DEFAULT 1 NOT NULL,
	"last_reset_at" timestamp with time zone,
	CONSTRAINT "audit_chain_meta_singleton_ck" CHECK ("audit_chain_meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"acting_role" text,
	"event_type" text NOT NULL,
	"tasker_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_artifact_id" uuid,
	"request_id" uuid NOT NULL,
	"chain_epoch" integer DEFAULT 0 NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_event_id_unique" UNIQUE("id"),
	CONSTRAINT "audit_event_actor_ck" CHECK (("audit_event"."actor_type" = 'user') = ("audit_event"."actor_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "clarification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"asked_by" uuid NOT NULL,
	"question" text NOT NULL,
	"answered_by" uuid,
	"answer" text,
	"answered_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disposition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"gate_id" uuid,
	"gate_round" integer,
	"type" "disposition_type" NOT NULL,
	"applied_by" uuid NOT NULL,
	"acting_role" text NOT NULL,
	"rationale" text,
	"redirect_to_user_id" uuid,
	"redirect_to_entry_id" uuid,
	"from_state" "tasker_state" NOT NULL,
	"to_state" "tasker_state" NOT NULL,
	"closes_tasker" boolean NOT NULL,
	"corrects_disposition_id" uuid,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposition_is_synthetic_ck" CHECK ("disposition"."is_synthetic" = true),
	CONSTRAINT "disposition_rationale_ck" CHECK ("disposition"."type" in ('completed','submitted','concurred') or coalesce(length(trim("disposition"."rationale")),0) > 0),
	CONSTRAINT "disposition_reassigned_redirect_ck" CHECK ("disposition"."type" <> 'reassigned' or "disposition"."redirect_to_user_id" is not null or "disposition"."redirect_to_entry_id" is not null),
	CONSTRAINT "disposition_gate_ck" CHECK ("disposition"."type" not in ('concurred','nonconcurred') or ("disposition"."gate_id" is not null and "disposition"."gate_round" is not null)),
	CONSTRAINT "disposition_closes_state_ck" CHECK ("disposition"."closes_tasker" = ("disposition"."to_state" = 'CLOSED')),
	CONSTRAINT "disposition_forwarding_never_closes_ck" CHECK (not "disposition"."closes_tasker" or "disposition"."type" not in ('reassigned','returned_for_rework','concurred','nonconcurred')),
	CONSTRAINT "disposition_reassigned_states_ck" CHECK ("disposition"."type" <> 'reassigned' or ("disposition"."from_state" in ('ASSIGNED','CLARIFICATION','IN_WORK','IN_COORDINATION','AWAITING_APPROVAL','TRIAGE') and "disposition"."to_state" = 'ASSIGNED')),
	CONSTRAINT "disposition_concur_states_ck" CHECK ("disposition"."type" <> 'concurred' or ("disposition"."from_state" = "disposition"."to_state" and "disposition"."from_state" <> 'CLOSED')),
	CONSTRAINT "disposition_nonconcur_states_ck" CHECK ("disposition"."type" <> 'nonconcurred' or (("disposition"."from_state" = 'IN_COORDINATION' and "disposition"."to_state" = 'IN_WORK') or ("disposition"."from_state" <> 'IN_COORDINATION' and "disposition"."from_state" = "disposition"."to_state" and "disposition"."from_state" <> 'CLOSED')))
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"enclave" "enclave" NOT NULL,
	"title" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"checked_out_by" uuid,
	"checked_out_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_is_synthetic_ck" CHECK ("document"."is_synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "document_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"body_md" text,
	"blob_key" text,
	"mime" text,
	"size_bytes" integer,
	"sha256" text NOT NULL,
	"author_type" "author_type" NOT NULL,
	"author_user_id" uuid,
	"ai_artifact_id" uuid,
	"derived_from_version_id" uuid,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_is_synthetic_ck" CHECK ("document_version"."is_synthetic" = true),
	CONSTRAINT "document_version_body_ck" CHECK ("document_version"."body_md" is not null or "document_version"."blob_key" is not null),
	CONSTRAINT "document_version_size_ck" CHECK ("document_version"."size_bytes" is null or "document_version"."size_bytes" <= 5242880),
	CONSTRAINT "document_version_author_ck" CHECK (("document_version"."author_type" = 'human' and "document_version"."author_user_id" is not null) or ("document_version"."author_type" = 'ai' and "document_version"."ai_artifact_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "escalation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"raised_by_role" text NOT NULL,
	"reason" text NOT NULL,
	"ai_warning_artifact_id" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolution" text,
	"auto_closed" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalation_is_synthetic_ck" CHECK ("escalation"."is_synthetic" = true),
	CONSTRAINT "escalation_reason_ck" CHECK (length(trim("escalation"."reason")) > 0),
	CONSTRAINT "escalation_resolution_ck" CHECK ("escalation"."resolved_at" is null or (coalesce(length(trim("escalation"."resolution")),0) > 0 and ("escalation"."resolved_by" is not null or "escalation"."auto_closed"))),
	CONSTRAINT "escalation_auto_closed_ck" CHECK (not "escalation"."auto_closed" or ("escalation"."resolved_at" is not null and "escalation"."resolved_by" is null))
);
--> statement-breakpoint
CREATE TABLE "gate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"kind" "gate_kind" NOT NULL,
	"sequence" integer NOT NULL,
	"office_label" text NOT NULL,
	"position_id" uuid,
	"assignee_user_id" uuid,
	"source" "gate_source" NOT NULL,
	"condition" text,
	"round" integer DEFAULT 1 NOT NULL,
	"package_version_id" uuid,
	"justification" text NOT NULL,
	"blocking" boolean DEFAULT true NOT NULL,
	"due_date" date NOT NULL,
	"status" "gate_status" DEFAULT 'pending' NOT NULL,
	"decision_comment" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_is_synthetic_ck" CHECK ("gate"."is_synthetic" = true),
	CONSTRAINT "gate_justification_ck" CHECK (length(trim("gate"."justification")) > 0),
	CONSTRAINT "gate_decision_comment_ck" CHECK ("gate"."status" not in ('nonconcurred','disapproved') or coalesce(length(trim("gate"."decision_comment")),0) > 0),
	CONSTRAINT "gate_assignee_when_open_ck" CHECK ("gate"."status" = 'pending' or "gate"."assignee_user_id" is not null),
	CONSTRAINT "gate_round_ck" CHECK ("gate"."round" >= 1)
);
--> statement-breakpoint
CREATE TABLE "holiday" (
	"day" date PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_key_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"field" text NOT NULL,
	"suggested_value" text NOT NULL,
	"ai_artifact_id" uuid,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_code" text NOT NULL,
	"echelon" "echelon" NOT NULL,
	"parent_org_id" uuid,
	"mission_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_short_code_unique" UNIQUE("short_code"),
	CONSTRAINT "org_is_synthetic_ck" CHECK ("org"."is_synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "outbox_delivery" (
	"outbox_event_id" uuid NOT NULL,
	"subscriber" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_seq" bigint,
	"event_type" text NOT NULL,
	"tasker_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"org_id" uuid NOT NULL,
	"incumbent_user_id" uuid,
	"alternate_user_id" uuid,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_is_synthetic_ck" CHECK ("position"."is_synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "registry_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"responsibility_id" text NOT NULL,
	"mission_function" text NOT NULL,
	"portfolio" text NOT NULL,
	"org_scope" jsonb NOT NULL,
	"accountable_position_id" uuid NOT NULL,
	"responsible_position_id" uuid NOT NULL,
	"designated_alternate_position_id" uuid,
	"designated_alternate_user_id" uuid,
	"supervisory_position_id" uuid NOT NULL,
	"mandatory_coordination" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"designated_approver_position_id" uuid NOT NULL,
	"standard_template_id" uuid,
	"baseline_timeline_profile" jsonb NOT NULL,
	"applicability_criteria" jsonb,
	"validation_cycle" "validation_cycle" DEFAULT 'quarterly' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"validated_by" uuid,
	"functional_owner_user_id" uuid NOT NULL,
	"task_categories" "task_category"[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "registry_status" DEFAULT 'draft' NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_entry_responsibility_id_unique" UNIQUE("responsibility_id"),
	CONSTRAINT "registry_entry_is_synthetic_ck" CHECK ("registry_entry"."is_synthetic" = true),
	CONSTRAINT "registry_entry_alternate_ck" CHECK ("registry_entry"."designated_alternate_position_id" is not null or "registry_entry"."designated_alternate_user_id" is not null),
	CONSTRAINT "registry_entry_active_validated_ck" CHECK ("registry_entry"."status" <> 'active' or ("registry_entry"."last_validated_at" is not null and "registry_entry"."validated_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "role_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "global_role" NOT NULL,
	"scope_org_id" uuid,
	"portfolio" text,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_grant_is_synthetic_ck" CHECK ("role_grant"."is_synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "sme_input" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"sme_user_id" uuid NOT NULL,
	"ask" text NOT NULL,
	"due_date" date,
	"status" "sme_status" DEFAULT 'requested' NOT NULL,
	"response" text,
	"attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"submitted_at" timestamp with time zone,
	"decline_reason" text,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sme_input_is_synthetic_ck" CHECK ("sme_input"."is_synthetic" = true),
	CONSTRAINT "sme_input_decline_ck" CHECK ("sme_input"."status" <> 'declined' or coalesce(length(trim("sme_input"."decline_reason")),0) > 0)
);
--> statement-breakpoint
CREATE TABLE "suspense_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"external_suspense" date NOT NULL,
	"stages" jsonb NOT NULL,
	"contingency_buffer_days" integer NOT NULL,
	"latest_ao_assignment_date" date NOT NULL,
	"ao_window_pct" numeric(5, 4) NOT NULL,
	"conflict" boolean NOT NULL,
	"computed_by" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suspense_plan_is_synthetic_ck" CHECK ("suspense_plan"."is_synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "suspense_resolution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"conflicted_plan_id" uuid NOT NULL,
	"resulting_plan_id" uuid,
	"option" "corrective_option" NOT NULL,
	"rationale" text NOT NULL,
	"resolved_by" uuid NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suspense_resolution_is_synthetic_ck" CHECK ("suspense_resolution"."is_synthetic" = true),
	CONSTRAINT "suspense_resolution_rationale_ck" CHECK (length(trim("suspense_resolution"."rationale")) > 0)
);
--> statement-breakpoint
CREATE TABLE "tasker" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"parent_tasker_id" uuid,
	"title" text NOT NULL,
	"category" "task_category" NOT NULL,
	"mission_function" text NOT NULL,
	"portfolio" text,
	"target_org_id" uuid NOT NULL,
	"requirement" text NOT NULL,
	"deliverable_format" text NOT NULL,
	"deliverable_template_id" uuid,
	"deliverable_criteria" text,
	"external_suspense" date NOT NULL,
	"priority" "tasker_priority" DEFAULT 'routine' NOT NULL,
	"state" "tasker_state" DEFAULT 'DRAFT' NOT NULL,
	"registry_entry_id" uuid,
	"match_snapshot" jsonb,
	"current_suspense_plan_id" uuid,
	"originator_id" uuid NOT NULL,
	"tasking_authority_id" uuid,
	"transmit_to_higher_hq" boolean,
	"submitted_for_release_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"first_viewed_by_ao_at" timestamp with time zone,
	"triage_entered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"final_disposition_id" uuid,
	"closed_disposition_type" "disposition_type",
	"elevated_nonconcurrence" jsonb,
	"row_version" integer DEFAULT 1 NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasker_ref_unique" UNIQUE("ref"),
	CONSTRAINT "tasker_is_synthetic_ck" CHECK ("tasker"."is_synthetic" = true),
	CONSTRAINT "tasker_released_fields_ck" CHECK ("tasker"."released_at" is null or ("tasker"."tasking_authority_id" is not null and "tasker"."current_suspense_plan_id" is not null and "tasker"."transmit_to_higher_hq" is not null and "tasker"."submitted_for_release_at" is not null)),
	CONSTRAINT "tasker_closed_fields_ck" CHECK (("tasker"."state" = 'CLOSED') = ("tasker"."closed_disposition_type" is not null and "tasker"."final_disposition_id" is not null and "tasker"."closed_at" is not null)),
	CONSTRAINT "tasker_closed_type_not_forwarding_ck" CHECK ("tasker"."closed_disposition_type" not in ('reassigned','returned_for_rework','concurred','nonconcurred')),
	CONSTRAINT "tasker_elevated_nonconcurrence_ck" CHECK ("tasker"."elevated_nonconcurrence" is null or (
        jsonb_typeof("tasker"."elevated_nonconcurrence"->'gate_ids') = 'array'
        and jsonb_typeof("tasker"."elevated_nonconcurrence"->'gate_rounds') = 'array'
        and jsonb_array_length("tasker"."elevated_nonconcurrence"->'gate_ids') > 0
        and jsonb_array_length("tasker"."elevated_nonconcurrence"->'gate_ids') = jsonb_array_length("tasker"."elevated_nonconcurrence"->'gate_rounds')
        and coalesce(length(trim("tasker"."elevated_nonconcurrence"->>'rationale')), 0) > 0
      )),
	CONSTRAINT "tasker_submitted_for_release_ck" CHECK ("tasker"."state" in ('DRAFT','CLOSED') or "tasker"."submitted_for_release_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "tasker_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid,
	"role" "tasker_role" NOT NULL,
	"source" "assignment_source" NOT NULL,
	"rationale" text,
	"assigned_by" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"accepted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasker_assignment_is_synthetic_ck" CHECK ("tasker_assignment"."is_synthetic" = true),
	CONSTRAINT "tasker_assignment_rationale_ck" CHECK ("tasker_assignment"."source" not in ('manual','reassignment') or coalesce(length(trim("tasker_assignment"."rationale")),0) > 0)
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "task_category" NOT NULL,
	"body_md" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_code_unique" UNIQUE("code"),
	CONSTRAINT "template_is_synthetic_ck" CHECK ("template"."is_synthetic" = true)
);
--> statement-breakpoint
ALTER TABLE "ai_artifact" ADD CONSTRAINT "ai_artifact_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_artifact" ADD CONSTRAINT "ai_artifact_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_verification" ADD CONSTRAINT "ai_verification_ai_artifact_id_ai_artifact_id_fk" FOREIGN KEY ("ai_artifact_id") REFERENCES "public"."ai_artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_verification" ADD CONSTRAINT "ai_verification_verified_by_app_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_ai_artifact_id_ai_artifact_id_fk" FOREIGN KEY ("ai_artifact_id") REFERENCES "public"."ai_artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification" ADD CONSTRAINT "clarification_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification" ADD CONSTRAINT "clarification_asked_by_app_user_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification" ADD CONSTRAINT "clarification_answered_by_app_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_gate_id_gate_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_applied_by_app_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_redirect_to_user_id_app_user_id_fk" FOREIGN KEY ("redirect_to_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_redirect_to_entry_id_registry_entry_id_fk" FOREIGN KEY ("redirect_to_entry_id") REFERENCES "public"."registry_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_corrects_disposition_id_disposition_id_fk" FOREIGN KEY ("corrects_disposition_id") REFERENCES "public"."disposition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_checked_out_by_app_user_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_ai_artifact_id_ai_artifact_id_fk" FOREIGN KEY ("ai_artifact_id") REFERENCES "public"."ai_artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_derived_from_version_id_document_version_id_fk" FOREIGN KEY ("derived_from_version_id") REFERENCES "public"."document_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation" ADD CONSTRAINT "escalation_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation" ADD CONSTRAINT "escalation_raised_by_app_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation" ADD CONSTRAINT "escalation_ai_warning_artifact_id_ai_artifact_id_fk" FOREIGN KEY ("ai_warning_artifact_id") REFERENCES "public"."ai_artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation" ADD CONSTRAINT "escalation_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_assignee_user_id_app_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_package_version_id_document_version_id_fk" FOREIGN KEY ("package_version_id") REFERENCES "public"."document_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_key_suggestion" ADD CONSTRAINT "match_key_suggestion_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_key_suggestion" ADD CONSTRAINT "match_key_suggestion_ai_artifact_id_ai_artifact_id_fk" FOREIGN KEY ("ai_artifact_id") REFERENCES "public"."ai_artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_key_suggestion" ADD CONSTRAINT "match_key_suggestion_accepted_by_app_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_parent_org_id_org_id_fk" FOREIGN KEY ("parent_org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_outbox_event_id_outbox_event_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."outbox_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_incumbent_user_id_app_user_id_fk" FOREIGN KEY ("incumbent_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_alternate_user_id_app_user_id_fk" FOREIGN KEY ("alternate_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_accountable_position_id_position_id_fk" FOREIGN KEY ("accountable_position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_responsible_position_id_position_id_fk" FOREIGN KEY ("responsible_position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_designated_alternate_position_id_position_id_fk" FOREIGN KEY ("designated_alternate_position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_designated_alternate_user_id_app_user_id_fk" FOREIGN KEY ("designated_alternate_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_supervisory_position_id_position_id_fk" FOREIGN KEY ("supervisory_position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_designated_approver_position_id_position_id_fk" FOREIGN KEY ("designated_approver_position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_standard_template_id_template_id_fk" FOREIGN KEY ("standard_template_id") REFERENCES "public"."template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_validated_by_app_user_id_fk" FOREIGN KEY ("validated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_entry" ADD CONSTRAINT "registry_entry_functional_owner_user_id_app_user_id_fk" FOREIGN KEY ("functional_owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_scope_org_id_org_id_fk" FOREIGN KEY ("scope_org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_granted_by_app_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sme_input" ADD CONSTRAINT "sme_input_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sme_input" ADD CONSTRAINT "sme_input_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sme_input" ADD CONSTRAINT "sme_input_sme_user_id_app_user_id_fk" FOREIGN KEY ("sme_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspense_plan" ADD CONSTRAINT "suspense_plan_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspense_plan" ADD CONSTRAINT "suspense_plan_computed_by_app_user_id_fk" FOREIGN KEY ("computed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspense_resolution" ADD CONSTRAINT "suspense_resolution_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspense_resolution" ADD CONSTRAINT "suspense_resolution_conflicted_plan_id_suspense_plan_id_fk" FOREIGN KEY ("conflicted_plan_id") REFERENCES "public"."suspense_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspense_resolution" ADD CONSTRAINT "suspense_resolution_resulting_plan_id_suspense_plan_id_fk" FOREIGN KEY ("resulting_plan_id") REFERENCES "public"."suspense_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspense_resolution" ADD CONSTRAINT "suspense_resolution_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_parent_tasker_id_tasker_id_fk" FOREIGN KEY ("parent_tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_target_org_id_org_id_fk" FOREIGN KEY ("target_org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_deliverable_template_id_template_id_fk" FOREIGN KEY ("deliverable_template_id") REFERENCES "public"."template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_registry_entry_id_registry_entry_id_fk" FOREIGN KEY ("registry_entry_id") REFERENCES "public"."registry_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_current_suspense_plan_id_suspense_plan_id_fk" FOREIGN KEY ("current_suspense_plan_id") REFERENCES "public"."suspense_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_originator_id_app_user_id_fk" FOREIGN KEY ("originator_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_tasking_authority_id_app_user_id_fk" FOREIGN KEY ("tasking_authority_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker" ADD CONSTRAINT "tasker_final_disposition_id_disposition_id_fk" FOREIGN KEY ("final_disposition_id") REFERENCES "public"."disposition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker_assignment" ADD CONSTRAINT "tasker_assignment_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker_assignment" ADD CONSTRAINT "tasker_assignment_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker_assignment" ADD CONSTRAINT "tasker_assignment_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasker_assignment" ADD CONSTRAINT "tasker_assignment_assigned_by_app_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_artifact_tasker_idx" ON "ai_artifact" USING btree ("tasker_id");--> statement-breakpoint
CREATE INDEX "audit_event_tasker_idx" ON "audit_event" USING btree ("tasker_id","seq");--> statement-breakpoint
CREATE INDEX "audit_event_type_idx" ON "audit_event" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "disposition_tasker_idx" ON "disposition" USING btree ("tasker_id");--> statement-breakpoint
CREATE INDEX "document_tasker_idx" ON "document" USING btree ("tasker_id","enclave");--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_no_uq" ON "document_version" USING btree ("document_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_one_open_uq" ON "escalation" USING btree ("tasker_id") WHERE "escalation"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "gate_tasker_idx" ON "gate" USING btree ("tasker_id","sequence");--> statement-breakpoint
CREATE INDEX "org_parent_idx" ON "org" USING btree ("parent_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_delivery_uq" ON "outbox_delivery" USING btree ("outbox_event_id","subscriber");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_event" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "registry_entry_match_idx" ON "registry_entry" USING btree ("status","mission_function");--> statement-breakpoint
CREATE INDEX "role_grant_user_idx" ON "role_grant" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suspense_plan_version_uq" ON "suspense_plan" USING btree ("tasker_id","version");--> statement-breakpoint
CREATE INDEX "tasker_state_idx" ON "tasker" USING btree ("state");--> statement-breakpoint
CREATE INDEX "tasker_closed_type_idx" ON "tasker" USING btree ("closed_disposition_type");--> statement-breakpoint
CREATE INDEX "tasker_target_org_idx" ON "tasker" USING btree ("target_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasker_one_active_apo_uq" ON "tasker_assignment" USING btree ("tasker_id") WHERE "tasker_assignment"."role" = 'accountable_product_owner' and "tasker_assignment"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "tasker_one_active_ao_uq" ON "tasker_assignment" USING btree ("tasker_id") WHERE "tasker_assignment"."role" = 'ao_primary' and "tasker_assignment"."active";--> statement-breakpoint
CREATE INDEX "tasker_assignment_user_idx" ON "tasker_assignment" USING btree ("user_id","active");