CREATE TYPE "public"."connection_status" AS ENUM('untested', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."jira_auth_type" AS ENUM('basic', 'oauth', 'pat');--> statement-breakpoint
CREATE TYPE "public"."jira_deployment" AS ENUM('cloud', 'datacenter');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai', 'google', 'azure', 'mistral', 'openai_compatible');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"deployment" "jira_deployment" NOT NULL,
	"auth_type" "jira_auth_type" NOT NULL,
	"base_url" text NOT NULL,
	"cloud_id" text,
	"account_id" text,
	"account_name" text,
	"secret" text NOT NULL,
	"status" "connection_status" DEFAULT 'untested' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"label" text NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"azure_resource_name" text,
	"key_hint" text,
	"secret" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "connection_status" DEFAULT 'untested' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_data_keys" (
	"org_id" text PRIMARY KEY NOT NULL,
	"kek_version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_data_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_connections_org_url_uq" ON "jira_connections" USING btree ("org_id","base_url");--> statement-breakpoint
CREATE INDEX "llm_connections_org_idx" ON "llm_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_connections_one_default_uq" ON "llm_connections" USING btree ("org_id") WHERE "llm_connections"."is_default";--> statement-breakpoint
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO public USING ("audit_log"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("audit_log"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_connections_tenant_isolation" ON "jira_connections" AS PERMISSIVE FOR ALL TO public USING ("jira_connections"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_connections"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "llm_connections_tenant_isolation" ON "llm_connections" AS PERMISSIVE FOR ALL TO public USING ("llm_connections"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("llm_connections"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "org_data_keys_tenant_isolation" ON "org_data_keys" AS PERMISSIVE FOR ALL TO public USING ("org_data_keys"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("org_data_keys"."org_id" = current_setting('app.current_org_id', true));