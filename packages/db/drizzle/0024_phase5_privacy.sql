CREATE TABLE "deleted_organizations" (
	"deleted_org_id" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"conversation_retention_days" integer DEFAULT 180 NOT NULL,
	"usage_retention_days" integer DEFAULT 730 NOT NULL,
	"audit_retention_days" integer DEFAULT 365 NOT NULL,
	"external_mcp_enabled" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_settings_tenant_isolation" ON "org_settings" AS PERMISSIVE FOR ALL TO public USING ("org_settings"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("org_settings"."org_id" = current_setting('app.current_org_id', true));