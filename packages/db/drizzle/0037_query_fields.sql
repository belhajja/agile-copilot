ALTER TABLE "jira_issues" ADD COLUMN "labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD COLUMN "components" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD COLUMN "fix_versions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD COLUMN "epic_key" text;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD COLUMN "epic_name" text;--> statement-breakpoint
-- Boards resync completely once, to fill the new columns.
UPDATE "jira_boards" SET "last_full_sync_at" = NULL;