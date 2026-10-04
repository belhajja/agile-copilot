CREATE TYPE "public"."agent_approval_status" AS ENUM('pending', 'approved', 'denied', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "agent_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"approval_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"status" "agent_approval_status" DEFAULT 'pending' NOT NULL,
	"result_code" text,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"org_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" "agent_message_role" NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_conversation_id_id_pk" PRIMARY KEY("conversation_id","id")
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid,
	"llm_connection_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_connections" ADD COLUMN "input_price_micros" integer;--> statement-breakpoint
ALTER TABLE "llm_connections" ADD COLUMN "output_price_micros" integer;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approvals_conversation_approval_uq" ON "agent_approvals" USING btree ("conversation_id","approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approvals_conversation_call_uq" ON "agent_approvals" USING btree ("conversation_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_owner_idx" ON "agent_conversations" USING btree ("org_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_conversation_seq_uq" ON "agent_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "agent_usage_org_created_idx" ON "agent_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_usage_user_created_idx" ON "agent_usage" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE POLICY "agent_approvals_tenant_isolation" ON "agent_approvals" AS PERMISSIVE FOR ALL TO public USING ("agent_approvals"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("agent_approvals"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "agent_conversations_tenant_isolation" ON "agent_conversations" AS PERMISSIVE FOR ALL TO public USING ("agent_conversations"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("agent_conversations"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "agent_messages_tenant_isolation" ON "agent_messages" AS PERMISSIVE FOR ALL TO public USING ("agent_messages"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("agent_messages"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "agent_usage_tenant_isolation" ON "agent_usage" AS PERMISSIVE FOR ALL TO public USING ("agent_usage"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("agent_usage"."org_id" = current_setting('app.current_org_id', true));