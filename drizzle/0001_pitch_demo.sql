ALTER TABLE "app_user" ADD COLUMN "rank" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "afsc" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "primary_duty" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "functions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "supervisor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "leadership_title" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_supervisor_user_id_app_user_id_fk" FOREIGN KEY ("supervisor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_user_org_idx" ON "app_user" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "app_user_supervisor_idx" ON "app_user" USING btree ("supervisor_user_id");--> statement-breakpoint
CREATE TABLE "additional_duty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ended_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "additional_duty_is_synthetic_ck" CHECK ("is_synthetic" = true),
	CONSTRAINT "additional_duty_name_ck" CHECK (length(trim("name")) > 0)
);--> statement-breakpoint
ALTER TABLE "additional_duty" ADD CONSTRAINT "additional_duty_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "additional_duty_active_uq" ON "additional_duty" USING btree ("user_id", lower("name")) WHERE "ended_at" is null;--> statement-breakpoint
CREATE INDEX "additional_duty_user_idx" ON "additional_duty" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tasker" ADD COLUMN "routing_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "tasker" ADD COLUMN "routing_criteria" jsonb;--> statement-breakpoint
CREATE INDEX "tasker_routing_batch_idx" ON "tasker" USING btree ("routing_batch_id");--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"tasker_id" uuid,
	"subject_user_id" uuid,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_is_synthetic_ck" CHECK ("is_synthetic" = true),
	CONSTRAINT "notification_kind_ck" CHECK ("kind" in ('assigned','chain')),
	CONSTRAINT "notification_body_ck" CHECK (length(trim("body")) > 0)
);--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subject_user_id_app_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_recipient_idx" ON "notification" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE TABLE "outbound_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"simulated" boolean DEFAULT true NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_email_is_synthetic_ck" CHECK ("is_synthetic" = true),
	CONSTRAINT "outbound_email_simulated_ck" CHECK ("simulated" = true),
	CONSTRAINT "outbound_email_domain_ck" CHECK ("to_email" like '%@example.test')
);--> statement-breakpoint
ALTER TABLE "outbound_email" ADD CONSTRAINT "outbound_email_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_email" ADD CONSTRAINT "outbound_email_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_email_created_idx" ON "outbound_email" USING btree ("created_at");--> statement-breakpoint
CREATE TABLE "stored_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tasker_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" bytea NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"is_synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_document_is_synthetic_ck" CHECK ("is_synthetic" = true),
	CONSTRAINT "stored_document_name_ck" CHECK (length(trim("file_name")) > 0),
	CONSTRAINT "stored_document_size_ck" CHECK ("byte_size" > 0 AND "byte_size" <= 10485760 AND "byte_size" = octet_length("content")),
	CONSTRAINT "stored_document_sha_ck" CHECK (length("sha256") = 64),
	CONSTRAINT "stored_document_mime_ck" CHECK ("mime" in (
		'application/pdf',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'image/png',
		'image/jpeg',
		'image/gif',
		'image/webp',
		'text/plain'
	))
);--> statement-breakpoint
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_tasker_id_tasker_id_fk" FOREIGN KEY ("tasker_id") REFERENCES "public"."tasker"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_uploaded_by_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stored_document_tasker_idx" ON "stored_document" USING btree ("tasker_id");