-- Phase 5 roles, closed in the schema. Rows outside the four (comma lists such as `admin,member`,
-- leftover `member`, malformed values) become the strongest role they hold *exactly*, else `viewer`.
-- Exact, untrimmed entries only: better-auth never treated `' owner'` as an owner, so the rewrite
-- never promotes it. Settled invitations are history and keep their role.
UPDATE "member" SET "role" = CASE
    WHEN 'owner' = ANY (string_to_array("role", ',')) THEN 'owner'
    WHEN 'admin' = ANY (string_to_array("role", ',')) THEN 'admin'
    WHEN 'manager' = ANY (string_to_array("role", ',')) THEN 'manager'
    ELSE 'viewer'
  END
  WHERE "role" NOT IN ('owner', 'admin', 'manager', 'viewer');
--> statement-breakpoint
UPDATE "invitation" SET "role" = CASE
    WHEN 'owner' = ANY (string_to_array("role", ',')) THEN 'owner'
    WHEN 'admin' = ANY (string_to_array("role", ',')) THEN 'admin'
    WHEN 'manager' = ANY (string_to_array("role", ',')) THEN 'manager'
    ELSE 'viewer'
  END
  WHERE "status" = 'pending' AND "role" NOT IN ('owner', 'admin', 'manager', 'viewer');
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_role_check"
  CHECK ("role" IN ('owner', 'admin', 'manager', 'viewer'));
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_check"
  CHECK ("status" <> 'pending' OR "role" IN ('owner', 'admin', 'manager', 'viewer'));
