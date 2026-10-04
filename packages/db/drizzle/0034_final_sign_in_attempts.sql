CREATE TABLE "sign_in_attempts" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member" ALTER COLUMN "role" SET DEFAULT 'viewer';--> statement-breakpoint
CREATE INDEX "sign_in_attempts_window_idx" ON "sign_in_attempts" USING btree ("window_started_at");