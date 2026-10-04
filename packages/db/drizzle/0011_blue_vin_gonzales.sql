DROP INDEX "agent_approvals_conversation_call_uq";--> statement-breakpoint
CREATE INDEX "agent_approvals_conversation_call_idx" ON "agent_approvals" USING btree ("conversation_id","tool_call_id");