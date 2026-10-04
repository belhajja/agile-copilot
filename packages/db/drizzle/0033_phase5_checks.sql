-- Closed sets and bounds the app already validates, closed in the schema too (A-m11), like the
-- role CHECKs of 0021: export kinds (deletion attempts are throttled in the same table, P5-R44),
-- plan keys (null until a subscription exists) and the retention bounds of RETENTION_BOUNDS in
-- @agile/privacy (the audit floor is also enforced by purge_audit_log).
ALTER TABLE "personal_data_exports" ADD CONSTRAINT "personal_data_exports_kind_check"
  CHECK ("kind" IN ('personal', 'audit', 'deletion'));
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_check"
  CHECK ("plan" IS NULL OR "plan" IN ('free', 'team'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_conversation_retention_days_check"
  CHECK ("conversation_retention_days" BETWEEN 7 AND 3650);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_usage_retention_days_check"
  CHECK ("usage_retention_days" BETWEEN 30 AND 3650);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_audit_retention_days_check"
  CHECK ("audit_retention_days" BETWEEN 90 AND 3650);
