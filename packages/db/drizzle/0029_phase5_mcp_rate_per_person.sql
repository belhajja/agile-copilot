-- The rate limit is per person (all of their tokens share one budget). Windows only matter for the
-- current minute, so existing rows are dropped rather than converted.
DELETE FROM "mcp_rate_buckets";--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" DROP CONSTRAINT "mcp_rate_buckets_token_id_mcp_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" DROP CONSTRAINT "mcp_rate_buckets_token_id_window_start_pk";--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" DROP COLUMN "token_id";--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" ADD CONSTRAINT "mcp_rate_buckets_org_id_user_id_window_start_pk" PRIMARY KEY("org_id","user_id","window_start");--> statement-breakpoint
CREATE INDEX "mcp_rate_buckets_window_idx" ON "mcp_rate_buckets" USING btree ("org_id","window_start");
