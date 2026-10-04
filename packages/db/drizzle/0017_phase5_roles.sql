-- Phase 5 roles: the interim `member` role (Phase 1–4) becomes `viewer`, which keeps exactly what
-- members could do (analytics only, no live Jira). Admins promote people to `manager` explicitly.
UPDATE "member" SET "role" = 'viewer' WHERE "role" = 'member';
--> statement-breakpoint
UPDATE "invitation" SET "role" = 'viewer' WHERE "role" = 'member' AND "status" = 'pending';
