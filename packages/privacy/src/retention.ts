import {
  agentConversations,
  agentUsage,
  type Db,
  deletedOrganizations,
  organization,
  skillBuilderCalls,
  skillRuns,
  withOrg,
} from '@agile/db';
import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import { getWorkspaceSettings } from './settings';

const DAY = 86_400_000;
/** How long a deleted workspace's audit trail is kept (the record of the deletion). */
export const DELETED_ORG_AUDIT_DAYS = 90;
/**
 * Skill-builder reservations (P4-R29) only matter for the last hour (the hourly limit); a week
 * covers any clock skew and keeps them out of personal data longer than needed.
 */
export const BUILDER_CALLS_RETENTION_DAYS = 7;

export interface RetentionResult {
  conversations: number;
  /** Finished skill runs (their reports): same period as conversations. */
  skillRuns: number;
  usage: number;
  audit: number;
  /** Skill-builder reservations older than `BUILDER_CALLS_RETENTION_DAYS`. */
  builderCalls: number;
}

export interface RetentionRunResult {
  /** Workspaces processed (all of them unless the run was stopped). */
  workspaces: number;
  failed: number;
  deletedPurged: number;
}

/**
 * Applies one workspace's retention settings: idle conversations (their messages and approvals
 * cascade), finished skill runs with their reports (queued and running runs are never touched),
 * old usage records, old skill-builder reservations, and audit entries through `purge_audit_log`
 * (the only way the app role can delete audit rows). The function's floor is a global 90 days;
 * the workspace's own audit setting is applied here, as the cutoff passed to it (P5 L25).
 * Idempotent: running it twice the same day deletes nothing more.
 */
export async function applyRetention(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const s = await getWorkspaceSettings(db, orgId);
  const before = (days: number) => new Date(now.getTime() - days * DAY);
  return withOrg(db, orgId, async (tx) => {
    const conversations = await tx
      .delete(agentConversations)
      .where(lt(agentConversations.updatedAt, before(s.conversationRetentionDays)))
      .returning({ id: agentConversations.id });
    // The daily caps count runs of the last 24 hours: the conversation period is at least 7 days.
    const runs = await tx
      .delete(skillRuns)
      .where(
        and(
          lt(skillRuns.createdAt, before(s.conversationRetentionDays)),
          notInArray(skillRuns.status, ['queued', 'running']),
        ),
      )
      .returning({ id: skillRuns.id });
    const usage = await tx
      .delete(agentUsage)
      .where(lt(agentUsage.createdAt, before(s.usageRetentionDays)))
      .returning({ id: agentUsage.id });
    const builder = await tx
      .delete(skillBuilderCalls)
      .where(lt(skillBuilderCalls.createdAt, before(BUILDER_CALLS_RETENTION_DAYS)))
      .returning({ id: skillBuilderCalls.id });
    const [audit] = await tx.execute<{ n: number }>(
      sql`select purge_audit_log(${orgId}, ${before(s.auditRetentionDays).toISOString()}::timestamptz) as n`,
    );
    return {
      conversations: conversations.length,
      skillRuns: runs.length,
      usage: usage.length,
      audit: audit?.n ?? 0,
      builderCalls: builder.length,
    };
  });
}

/**
 * The daily retention run: every workspace's settings, then the audit trail of workspaces deleted
 * more than 90 days ago. One workspace failing does not stop the others; a stopped worker
 * (`signal`) ends the run between workspaces (the next day's run picks up the rest).
 */
export async function runRetention(
  db: Db,
  opts: {
    now?: Date;
    signal?: AbortSignal;
    onError?: (error: unknown, orgId: string) => void;
  } = {},
): Promise<RetentionRunResult> {
  const now = opts.now ?? new Date();
  const orgs = await db.select({ id: organization.id }).from(organization);
  let workspaces = 0;
  let failed = 0;
  for (const { id } of orgs) {
    if (opts.signal?.aborted) return { workspaces, failed, deletedPurged: 0 };
    try {
      await applyRetention(db, id, now);
    } catch (e) {
      failed++;
      opts.onError?.(e, id);
    }
    workspaces++;
  }
  const expired = await db
    .select({ id: deletedOrganizations.deletedOrgId })
    .from(deletedOrganizations)
    .where(
      lt(deletedOrganizations.deletedAt, new Date(now.getTime() - DELETED_ORG_AUDIT_DAYS * DAY)),
    );
  let deletedPurged = 0;
  for (const { id } of expired) {
    if (opts.signal?.aborted) break;
    try {
      await withOrg(db, id, (tx) =>
        tx.execute(sql`select purge_audit_log(${id}, ${now.toISOString()}::timestamptz)`),
      );
      await db.delete(deletedOrganizations).where(eq(deletedOrganizations.deletedOrgId, id));
      deletedPurged++;
    } catch (e) {
      failed++;
      opts.onError?.(e, id);
    }
  }
  return { workspaces, failed, deletedPurged };
}
