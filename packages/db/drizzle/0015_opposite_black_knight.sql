CREATE TABLE "skill_builder_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_builder_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "skill_builder_calls_user_created_idx" ON "skill_builder_calls" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE POLICY "skill_builder_calls_tenant_isolation" ON "skill_builder_calls" AS PERMISSIVE FOR ALL TO public USING ("skill_builder_calls"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("skill_builder_calls"."org_id" = current_setting('app.current_org_id', true));