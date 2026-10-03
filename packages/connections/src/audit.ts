import { auditLog, type Tx } from '@agile/db';

export type AuditAction =
  | 'jira_connection.created'
  | 'jira_connection.retested'
  | 'jira_connection.deleted'
  | 'jira_connection.token_refreshed'
  | 'llm_connection.created'
  | 'llm_connection.retested'
  | 'llm_connection.deleted'
  | 'llm_connection.default_changed';

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
