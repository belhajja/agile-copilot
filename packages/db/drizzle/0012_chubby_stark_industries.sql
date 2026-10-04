CREATE TYPE "public"."delivery_channel_kind" AS ENUM('smtp', 'slack', 'teams');--> statement-breakpoint
CREATE TYPE "public"."skill_output" AS ENUM('chat', 'dashboard_card', 'email', 'slack', 'teams');--> statement-breakpoint
CREATE TYPE "public"."skill_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."skill_run_trigger" AS ENUM('schedule', 'alert', 'manual');--> statement-breakpoint
CREATE TYPE "public"."skill_trigger" AS ENUM('on_demand', 'always', 'schedule', 'alert');--> statement-breakpoint
CREATE TYPE "public"."skill_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TABLE "delivery_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "delivery_channel_kind" NOT NULL,
	"name" text NOT NULL,
	"hint" text NOT NULL,
	"secret" text NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"trigger" "skill_run_trigger" NOT NULL,
	"status" "skill_run_status" DEFAULT 'queued' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"result_code" text,
	"output" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_kind" text,
	"channel_id" uuid,
	"deliveries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"trigger" "skill_trigger" NOT NULL,
	"output" "skill_output" NOT NULL,
	"visibility" "skill_visibility" DEFAULT 'private' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"builtin_key" text,
	"forked_from_id" uuid,
	"forked_from_version" integer,
	"channel_id" uuid,
	"schedule_cursor" timestamp with time zone,
	"alert_boards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alert_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD COLUMN "skill_run_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_connections" ADD COLUMN "is_background" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_channel_id_delivery_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."delivery_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_channels_org_name_uq" ON "delivery_channels" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_channels_one_smtp_uq" ON "delivery_channels" USING btree ("org_id") WHERE "delivery_channels"."kind" = 'smtp';--> statement-breakpoint
CREATE UNIQUE INDEX "skill_runs_skill_scheduled_uq" ON "skill_runs" USING btree ("skill_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "skill_runs_skill_created_idx" ON "skill_runs" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_runs_channel_idx" ON "skill_runs" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "skill_runs_org_created_idx" ON "skill_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_uq" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_name_uq" ON "skills" USING btree ("org_id","owner_user_id","name");--> statement-breakpoint
CREATE INDEX "skills_org_trigger_idx" ON "skills" USING btree ("org_id","trigger");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_connections_one_background_uq" ON "llm_connections" USING btree ("org_id") WHERE "llm_connections"."is_background";--> statement-breakpoint
CREATE POLICY "delivery_channels_tenant_isolation" ON "delivery_channels" AS PERMISSIVE FOR ALL TO public USING ("delivery_channels"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("delivery_channels"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "skill_runs_tenant_isolation" ON "skill_runs" AS PERMISSIVE FOR ALL TO public USING ("skill_runs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("skill_runs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "skill_versions_tenant_isolation" ON "skill_versions" AS PERMISSIVE FOR ALL TO public USING ("skill_versions"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("skill_versions"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "skills_tenant_isolation" ON "skills" AS PERMISSIVE FOR ALL TO public USING ("skills"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("skills"."org_id" = current_setting('app.current_org_id', true));