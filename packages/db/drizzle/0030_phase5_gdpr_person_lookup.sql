CREATE TABLE "personal_data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "personal_data_exports" ADD CONSTRAINT "personal_data_exports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_data_exports_user_started_idx" ON "personal_data_exports" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_approvals_user_idx" ON "agent_approvals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_user_idx" ON "agent_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_usage_user_idx" ON "agent_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "dashboards_user_idx" ON "dashboards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_rate_buckets_user_idx" ON "mcp_rate_buckets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_user_idx" ON "mcp_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skill_builder_calls_user_idx" ON "skill_builder_calls" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skill_runs_owner_idx" ON "skill_runs" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "skills_owner_idx" ON "skills" USING btree ("owner_user_id");--> statement-breakpoint
-- GDPR export and erasure (P5-R37): the workspaces one person has rows in, members or not (a
-- former member's conversations, skills, runs, usage, tokens, audit entries). RLS shows the app one
-- workspace at a time, so this runs as the migration owner (SECURITY DEFINER, pinned search_path).
-- It returns workspace ids only, never rows. Personal tables are discovered as in @agile/privacy
-- (org_id plus user_id/owner_user_id), so later tables are covered; every such column has an index
-- leading with it (this migration), so each probe is an index lookup. `row_security = off` makes a
-- function owner that does not bypass RLS fail loudly instead of silently finding nothing.
CREATE OR REPLACE FUNCTION user_org_ids(p_user_id text)
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  r record;
  ids text[];
  found text[];
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'user_org_ids: user id required';
  END IF;
  ids := ARRAY(SELECT DISTINCT a.org_id FROM audit_log a WHERE a.actor_user_id = p_user_id);
  FOR r IN
    SELECT c.table_name AS tbl, c.column_name AS col
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.column_name IN ('user_id', 'owner_user_id')
      AND EXISTS (SELECT 1 FROM information_schema.columns o
        WHERE o.table_schema = 'public' AND o.table_name = c.table_name AND o.column_name = 'org_id')
  LOOP
    EXECUTE format(
      'SELECT ARRAY(SELECT DISTINCT org_id::text FROM public.%I WHERE %I::text = $1)',
      r.tbl, r.col
    ) INTO found USING p_user_id;
    ids := ids || found;
  END LOOP;
  RETURN QUERY SELECT DISTINCT u FROM unnest(ids) AS u ORDER BY u;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION user_org_ids(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_org_ids(text) TO app_user;
