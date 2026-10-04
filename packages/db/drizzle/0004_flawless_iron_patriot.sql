CREATE TYPE "public"."dashboard_kind" AS ENUM('scrum', 'kanban', 'custom');--> statement-breakpoint
CREATE TYPE "public"."jira_board_type" AS ENUM('scrum', 'kanban', 'simple');--> statement-breakpoint
CREATE TYPE "public"."jira_issue_change_kind" AS ENUM('estimate', 'flag');--> statement-breakpoint
CREATE TYPE "public"."jira_sprint_state" AS ENUM('future', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."status_category" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "public"."status_mapping_source" AS ENUM('auto', 'user');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('incremental', 'full');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('idle', 'queued', 'running', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('manual', 'schedule');--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "dashboard_kind" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"widgets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_board_issues" (
	"org_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	CONSTRAINT "jira_board_issues_board_id_issue_id_pk" PRIMARY KEY("board_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "jira_board_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_board_sprints" (
	"org_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"sprint_id" uuid NOT NULL,
	CONSTRAINT "jira_board_sprints_board_id_sprint_id_pk" PRIMARY KEY("board_id","sprint_id")
);
--> statement-breakpoint
ALTER TABLE "jira_board_sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jira_board_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" "jira_board_type" NOT NULL,
	"project_key" text,
	"filter_id" integer,
	"estimation_field_id" text,
	"estimation_field_name" text,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_issue_changes" (
	"org_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" "jira_issue_change_kind" NOT NULL,
	"from_value" text,
	"to_value" text,
	CONSTRAINT "jira_issue_changes_issue_id_seq_pk" PRIMARY KEY("issue_id","seq")
);
--> statement-breakpoint
ALTER TABLE "jira_issue_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_issue_transitions" (
	"org_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_status_id" text,
	"to_status_id" text NOT NULL,
	CONSTRAINT "jira_issue_transitions_issue_id_seq_pk" PRIMARY KEY("issue_id","seq")
);
--> statement-breakpoint
ALTER TABLE "jira_issue_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jira_issue_id" text NOT NULL,
	"key" text NOT NULL,
	"summary" text NOT NULL,
	"issue_type" text NOT NULL,
	"is_subtask" boolean DEFAULT false NOT NULL,
	"status_id" text NOT NULL,
	"assignee_id" text,
	"assignee_name" text,
	"estimate" double precision,
	"jira_created_at" timestamp with time zone NOT NULL,
	"jira_updated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sprint_issues" (
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"jira_sprint_id" integer NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "jira_sprint_issues_issue_id_jira_sprint_id_added_at_pk" PRIMARY KEY("issue_id","jira_sprint_id","added_at")
);
--> statement-breakpoint
ALTER TABLE "jira_sprint_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jira_sprint_id" integer NOT NULL,
	"name" text NOT NULL,
	"state" "jira_sprint_state" NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"complete_at" timestamp with time zone,
	"goal" text,
	"origin_board_jira_id" integer
);
--> statement-breakpoint
ALTER TABLE "jira_sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_status_mappings" (
	"org_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"jira_status_id" text NOT NULL,
	"status_name" text NOT NULL,
	"jira_category" text NOT NULL,
	"category" "status_category" NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"source" "status_mapping_source" DEFAULT 'auto' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jira_status_mappings_board_id_jira_status_id_pk" PRIMARY KEY("board_id","jira_status_id")
);
--> statement-breakpoint
ALTER TABLE "jira_status_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" "sync_trigger" NOT NULL,
	"mode" "sync_mode" NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"boards_synced" integer DEFAULT 0 NOT NULL,
	"issues_upserted" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "jira_sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sync_states" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" "sync_status" DEFAULT 'idle' NOT NULL,
	"watermark" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_sync_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_issues" ADD CONSTRAINT "jira_board_issues_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_issues" ADD CONSTRAINT "jira_board_issues_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_sprints" ADD CONSTRAINT "jira_board_sprints_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_sprints" ADD CONSTRAINT "jira_board_sprints_sprint_id_jira_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."jira_sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_boards" ADD CONSTRAINT "jira_boards_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue_changes" ADD CONSTRAINT "jira_issue_changes_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue_transitions" ADD CONSTRAINT "jira_issue_transitions_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sprint_issues" ADD CONSTRAINT "jira_sprint_issues_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sprint_issues" ADD CONSTRAINT "jira_sprint_issues_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sprints" ADD CONSTRAINT "jira_sprints_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_status_mappings" ADD CONSTRAINT "jira_status_mappings_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sync_states" ADD CONSTRAINT "jira_sync_states_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_owner_idx" ON "dashboards" USING btree ("org_id","user_id","board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_default_uq" ON "dashboards" USING btree ("board_id","user_id","kind") WHERE "dashboards"."kind" <> 'custom';--> statement-breakpoint
CREATE UNIQUE INDEX "jira_boards_connection_board_uq" ON "jira_boards" USING btree ("connection_id","jira_board_id");--> statement-breakpoint
CREATE INDEX "jira_boards_org_idx" ON "jira_boards" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_issues_connection_issue_uq" ON "jira_issues" USING btree ("connection_id","jira_issue_id");--> statement-breakpoint
CREATE INDEX "jira_issues_org_idx" ON "jira_issues" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jira_sprint_issues_sprint_idx" ON "jira_sprint_issues" USING btree ("connection_id","jira_sprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_sprints_connection_sprint_uq" ON "jira_sprints" USING btree ("connection_id","jira_sprint_id");--> statement-breakpoint
CREATE INDEX "jira_sync_runs_connection_started_idx" ON "jira_sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE POLICY "dashboards_tenant_isolation" ON "dashboards" AS PERMISSIVE FOR ALL TO public USING ("dashboards"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("dashboards"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_board_issues_tenant_isolation" ON "jira_board_issues" AS PERMISSIVE FOR ALL TO public USING ("jira_board_issues"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_board_issues"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_board_sprints_tenant_isolation" ON "jira_board_sprints" AS PERMISSIVE FOR ALL TO public USING ("jira_board_sprints"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_board_sprints"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_boards_tenant_isolation" ON "jira_boards" AS PERMISSIVE FOR ALL TO public USING ("jira_boards"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_boards"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_issue_changes_tenant_isolation" ON "jira_issue_changes" AS PERMISSIVE FOR ALL TO public USING ("jira_issue_changes"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_issue_changes"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_issue_transitions_tenant_isolation" ON "jira_issue_transitions" AS PERMISSIVE FOR ALL TO public USING ("jira_issue_transitions"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_issue_transitions"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_issues_tenant_isolation" ON "jira_issues" AS PERMISSIVE FOR ALL TO public USING ("jira_issues"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_issues"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sprint_issues_tenant_isolation" ON "jira_sprint_issues" AS PERMISSIVE FOR ALL TO public USING ("jira_sprint_issues"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sprint_issues"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sprints_tenant_isolation" ON "jira_sprints" AS PERMISSIVE FOR ALL TO public USING ("jira_sprints"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sprints"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_status_mappings_tenant_isolation" ON "jira_status_mappings" AS PERMISSIVE FOR ALL TO public USING ("jira_status_mappings"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_status_mappings"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sync_runs_tenant_isolation" ON "jira_sync_runs" AS PERMISSIVE FOR ALL TO public USING ("jira_sync_runs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sync_runs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sync_states_tenant_isolation" ON "jira_sync_states" AS PERMISSIVE FOR ALL TO public USING ("jira_sync_states"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sync_states"."org_id" = current_setting('app.current_org_id', true));