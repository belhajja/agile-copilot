CREATE TABLE "agent_conversation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversation_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "llm_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_conversation_groups_owner_idx" ON "agent_conversation_groups" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_llm_connection_id_llm_connections_id_fk" FOREIGN KEY ("llm_connection_id") REFERENCES "public"."llm_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_group_id_agent_conversation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."agent_conversation_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_conversations_llm_connection_idx" ON "agent_conversations" USING btree ("llm_connection_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_group_idx" ON "agent_conversations" USING btree ("group_id");--> statement-breakpoint
CREATE POLICY "agent_conversation_groups_tenant_isolation" ON "agent_conversation_groups" AS PERMISSIVE FOR ALL TO public USING ("agent_conversation_groups"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("agent_conversation_groups"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "agent_conversation_groups" FORCE ROW LEVEL SECURITY;
