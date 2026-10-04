CREATE TABLE "billing_subscriptions" (
	"org_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text,
	"plan" text,
	"status" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_customer_uq" ON "billing_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE POLICY "billing_subscriptions_tenant_isolation" ON "billing_subscriptions" AS PERMISSIVE FOR ALL TO public USING ("billing_subscriptions"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("billing_subscriptions"."org_id" = current_setting('app.current_org_id', true));