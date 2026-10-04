CREATE INDEX "invitation_inviterId_idx" ON "invitation" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "dashboards_board_idx" ON "dashboards" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "jira_board_issues_issue_idx" ON "jira_board_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "jira_board_sprints_sprint_idx" ON "jira_board_sprints" USING btree ("sprint_id");