CREATE TABLE "mcp_rate_buckets" (
	"org_id" text NOT NULL,
	"token_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mcp_rate_buckets_token_id_window_start_pk" PRIMARY KEY("token_id","window_start")
);
--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" ADD CONSTRAINT "mcp_rate_buckets_token_id_mcp_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tokens_hash_idx" ON "mcp_tokens" USING btree ("org_id","token_hash");--> statement-breakpoint
CREATE INDEX "mcp_tokens_owner_idx" ON "mcp_tokens" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE POLICY "mcp_rate_buckets_tenant_isolation" ON "mcp_rate_buckets" AS PERMISSIVE FOR ALL TO public USING ("mcp_rate_buckets"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("mcp_rate_buckets"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "mcp_tokens_tenant_isolation" ON "mcp_tokens" AS PERMISSIVE FOR ALL TO public USING ("mcp_tokens"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("mcp_tokens"."org_id" = current_setting('app.current_org_id', true));