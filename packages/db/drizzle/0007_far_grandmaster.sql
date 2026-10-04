ALTER TABLE "jira_boards" ADD COLUMN "last_full_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jira_boards" ADD COLUMN "watermark" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jira_boards" ADD COLUMN "last_error" text;