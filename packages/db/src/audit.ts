import type { Tx } from './client';
import { auditLog } from './schema';

export type AuditAction =
  | 'jira_connection.created'
  | 'jira_connection.retested'
  | 'jira_connection.deleted'
  | 'jira_connection.token_refreshed'
  | 'llm_connection.created'
  | 'llm_connection.retested'
  | 'llm_connection.deleted'
  | 'llm_connection.default_changed'
  | 'jira_boards.discovered'
  | 'jira_boards.selection_changed'
  | 'jira_status_mapping.updated'
  | 'jira_sync.requested'
  | 'llm_connection.prices_changed'
  | 'agent_action.proposed'
  | 'agent_action.approved'
  | 'agent_action.rejected'
  | 'agent_action.executed'
  | 'agent_action.failed'
  | 'llm_connection.background_changed'
  | 'skill.created'
  | 'skill.updated'
  | 'skill.forked'
  | 'skill.visibility_changed'
  | 'skill.enabled_changed'
  | 'skill.deleted'
  | 'skill.run_requested'
  | 'delivery_channel.created'
  | 'delivery_channel.deleted'
  | 'dashboard.widget_pinned'
  | 'dashboard.widget_removed'
  | 'member.invited'
  | 'member.invitation_cancelled'
  | 'member.joined'
  | 'member.role_changed'
  | 'member.removed'
  | 'member.left';

/** metadata must never contain secrets — pass only non-sensitive descriptors. */
export async function recordAudit(
  tx: Tx,
  entry: {
    orgId: string;
    actorUserId: string | null;
    action: AuditAction;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLog).values({ ...entry, metadata: entry.metadata ?? {} });
}
