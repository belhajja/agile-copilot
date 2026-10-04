ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The app role cannot delete audit entries (0001). Retention goes through this function, which
-- only ever deletes one workspace's entries older than 90 days: a compromised app can never erase
-- recent history. It runs as the migration owner (SECURITY DEFINER) under that workspace's RLS
-- context, and restores the caller's context afterwards.
-- The floor is global (90 days), not the workspace's own audit retention setting (P5 L25): the
-- retention job (@agile/privacy applyRetention) passes the workspace's cutoff as p_before, and the
-- function only guarantees that nothing younger than 90 days is ever deleted.
CREATE OR REPLACE FUNCTION purge_audit_log(p_org_id text, p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.current_org_id', true);
  deleted integer;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' THEN
    RAISE EXCEPTION 'purge_audit_log: org id required';
  END IF;
  PERFORM set_config('app.current_org_id', p_org_id, true);
  DELETE FROM audit_log
  WHERE org_id = p_org_id
    AND created_at < LEAST(p_before, now() - interval '90 days');
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('app.current_org_id', coalesce(previous, ''), true);
  RETURN deleted;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_audit_log(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_audit_log(text, timestamptz) TO app_user;
