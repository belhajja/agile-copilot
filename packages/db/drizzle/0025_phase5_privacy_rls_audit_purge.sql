ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The app role cannot delete audit entries (0001). Retention goes through this function, which
-- only ever deletes the current workspace's entries older than 90 days: a compromised app can never
-- erase recent history. It runs as the migration owner (SECURITY DEFINER), only for the workspace
-- of the caller's RLS context (P5-R35a), at most p_limit rows per call (callers loop until it
-- returns fewer), and refuses a NULL cutoff (LEAST ignores NULLs, which would mean "everything").
-- The floor is global (90 days), not the workspace's own audit retention setting (P5 L25): the
-- retention job (@agile/privacy applyRetention) passes the workspace's cutoff as p_before, and the
-- function only guarantees that nothing younger than 90 days is ever deleted.
CREATE OR REPLACE FUNCTION purge_audit_log(p_org_id text, p_before timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  IF p_org_id IS NULL OR p_org_id = '' THEN
    RAISE EXCEPTION 'purge_audit_log: org id required';
  END IF;
  IF p_org_id IS DISTINCT FROM current_setting('app.current_org_id', true) THEN
    RAISE EXCEPTION 'purge_audit_log: org id must be the current workspace';
  END IF;
  IF p_before IS NULL THEN
    RAISE EXCEPTION 'purge_audit_log: cutoff required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'purge_audit_log: limit must be between 1 and 10000';
  END IF;
  DELETE FROM audit_log
  WHERE id IN (
    SELECT id FROM audit_log
    WHERE org_id = p_org_id
      AND created_at < LEAST(p_before, now() - interval '90 days')
    ORDER BY created_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_audit_log(text, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_audit_log(text, timestamptz, integer) TO app_user;
