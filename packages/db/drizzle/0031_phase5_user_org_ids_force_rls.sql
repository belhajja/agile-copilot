-- P5-R38: user_org_ids without superuser or BYPASSRLS. Managed Postgres rarely grants either to
-- the migration role, and FORCE RLS applies to table owners, so the function (owner's rights,
-- SECURITY DEFINER) now goes through RLS like the app: for each workspace it sets the workspace
-- context and probes every personal table with one EXISTS each (an index lookup on the
-- person-leading indexes of 0030). Workspaces are those in `organization` only: a deleted
-- workspace's rows are purged (its audit trail is kept on purpose and leaves with retention),
-- and callers only act on existing workspaces.
-- Each probe also filters on that workspace id, so an owner that does bypass RLS (a superuser,
-- as in development) gets the same answer. The caller's workspace context is restored before
-- returning; on an error the caller's transaction (or savepoint) rolls the setting back anyway.
-- (A function-level `SET app.current_org_id` would be simpler, but only a superuser may attach a
-- custom setting to a function.)
CREATE OR REPLACE FUNCTION user_org_ids(p_user_id text)
RETURNS SETOF text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prev text := coalesce(current_setting('app.current_org_id', true), '');
  probe text;
  o record;
  hit boolean;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'user_org_ids: user id required';
  END IF;
  SELECT string_agg(format('EXISTS (SELECT 1 FROM public.%I WHERE %I::text = $1 AND org_id = $2)', tbl, col), ' OR ')
  INTO probe
  FROM (
    SELECT 'audit_log'::text AS tbl, 'actor_user_id'::text AS col
    UNION ALL
    SELECT c.table_name::text, c.column_name::text
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.column_name IN ('user_id', 'owner_user_id')
      AND EXISTS (SELECT 1 FROM information_schema.columns x
        WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'org_id')
  ) personal;
  FOR o IN SELECT id FROM organization ORDER BY id LOOP
    PERFORM set_config('app.current_org_id', o.id, true);
    EXECUTE 'SELECT ' || probe INTO hit USING p_user_id, o.id;
    IF hit THEN
      RETURN NEXT o.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_org_id', prev, true);
  RETURN;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION user_org_ids(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_org_ids(text) TO app_user;
