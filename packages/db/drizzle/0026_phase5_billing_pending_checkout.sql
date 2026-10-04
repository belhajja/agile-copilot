ALTER TABLE "billing_subscriptions" ADD COLUMN "pending_checkout_session_id" text;--> statement-breakpoint
CREATE INDEX "stripe_events_created_at_idx" ON "stripe_events" USING btree ("created_at");