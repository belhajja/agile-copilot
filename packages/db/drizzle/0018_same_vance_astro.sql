ALTER TABLE "skill_runs" DROP CONSTRAINT "skill_runs_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_runs" ALTER COLUMN "skill_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;