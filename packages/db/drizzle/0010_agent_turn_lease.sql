ALTER TABLE "agent_conversations" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "turn_started_at" timestamp with time zone;