CREATE TABLE "agent_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_attachments_conversation_idx" ON "agent_attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_attachments_user_idx" ON "agent_attachments" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "agent_attachments_tenant_isolation" ON "agent_attachments" AS PERMISSIVE FOR ALL TO public USING ("agent_attachments"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("agent_attachments"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "agent_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- What the chat accepts (@agile/agent attachments): PNG, JPEG or WebP, at most 5 MiB each.
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_media_type_check"
  CHECK ("media_type" IN ('image/png', 'image/jpeg', 'image/webp'));--> statement-breakpoint
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_byte_size_check"
  CHECK ("byte_size" BETWEEN 1 AND 5242880 AND "byte_size" = octet_length("bytes"));