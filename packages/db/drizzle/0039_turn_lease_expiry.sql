ALTER TABLE "agent_conversations" ADD COLUMN "turn_expires_at" timestamp with time zone;--> statement-breakpoint
-- A turn running during the upgrade keeps the lease it had (10 minutes).
UPDATE "agent_conversations" SET "turn_expires_at" = "turn_started_at" + interval '600 seconds' WHERE "turn_id" IS NOT NULL;
