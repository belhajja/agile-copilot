GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
--> statement-breakpoint
ALTER TABLE org_data_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE llm_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
