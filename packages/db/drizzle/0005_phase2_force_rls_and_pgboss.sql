ALTER TABLE jira_boards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_status_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sync_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sync_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_board_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_issue_transitions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_issue_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sprints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_board_sprints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sprint_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- pg-boss (job queue) keeps its tables in its own schema, owned by the app role so the web app and
-- worker can install and migrate it at startup (they run pg-boss with createSchema: false).
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_user;
