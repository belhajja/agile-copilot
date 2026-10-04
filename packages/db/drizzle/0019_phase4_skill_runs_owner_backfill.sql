-- P4-R31: every existing run takes the owner of its skill (the table owner is exempt from RLS
-- only while it is not forced, so FORCE is lifted for the backfill and restored right after).
ALTER TABLE skill_runs NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE skills NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE skill_runs r SET owner_user_id = s.owner_user_id FROM skills s WHERE s.id = r.skill_id AND r.owner_user_id IS NULL;--> statement-breakpoint
ALTER TABLE skills FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE skill_runs FORCE ROW LEVEL SECURITY;
