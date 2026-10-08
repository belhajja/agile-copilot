import {
  agentConversations,
  agentUsage,
  type Db,
  deletedOrganizations,
  invitation,
  jiraSyncRuns,
  mcpRateBuckets,
  mcpTokens,
  organization,
  personalDataExports,
  session,
  signInAttempts,
  skillBuilderCalls,
  skillRuns,
  stripeEvents,
  type Tx,
  verification,
  withOrg,
} from '@agile/db';
import { and, eq, exists, gt, inArray, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getWorkspaceSettings } from './settings';

const DAY = 86_400_000;
/** How long a deleted workspace's audit trail is kept (the record of the deletion). */
export const DELETED_ORG_AUDIT_DAYS = 90;
/**
 * Skill-builder reservations (P4-R29) only matter for the last hour (the hourly limit); a week
 * covers any clock skew and keeps them out of personal data longer than needed.
 */
export const BUILDER_CALLS_RETENTION_DAYS = 7;
/** Sync runs (an operational log): older ones go, except each connection's latest finished run. */
export const SYNC_RUNS_RETENTION_DAYS = 90;
/** Sessions and verifications are deleted this long after they expired. */
export const EXPIRED_AUTH_GRACE_DAYS = 1;
/** External MCP rate windows only matter for the current minute; a day covers any clock skew. */
const MCP_RATE_WINDOWS_RETENTION_DAYS = 1;
/** MCP tokens are deleted this long after they were revoked or expired (lists show them meanwhile). */
const MCP_TOKENS_RETENTION_DAYS = 90;
/**
 * Invitations (they hold the invitee's e-mail address, P5-R45) are deleted this long after they
 * were answered or withdrawn (any status but pending; counted from when they were sent), and
 * pending ones this long after they expired.
 */
export const INVITATIONS_RETENTION_DAYS = 30;
/**
 * Export and account-deletion attempt records (the throttles count the last hour only) are
 * deleted this long after they started: they say when a person exported their data.
 */
export const PERSONAL_DATA_EXPORTS_RETENTION_DAYS = 30;
/** Processed Stripe event ids (deduplication; Stripe retries deliveries for 3 days). */
export const STRIPE_EVENTS_RETENTION_DAYS = 30;
/**
 * Per-account sign-in attempt windows (P5-R47): the limiter only reads the last 15 minutes; a
 * day covers any clock skew. Keyed hashes of addresses, still not kept longer than needed.
 */
export const SIGN_IN_ATTEMPTS_RETENTION_DAYS = 1;
/** Rows deleted per statement, each in its own short transaction. */
export const RETENTION_BATCH_SIZE = 5000;

const FINISHED_RUNS = ['succeeded', 'failed', 'skipped'] as const;
const FINISHED_SYNCS = ['ok', 'error'] as const;

export interface RetentionResult {
  conversations: number;
  /** Finished skill runs (their reports): same period as conversations, never a skill's latest. */
  skillRuns: number;
  usage: number;
  audit: number;
  /** Skill-builder reservations older than `BUILDER_CALLS_RETENTION_DAYS`. */
  builderCalls: number;
  /** Sync runs older than `SYNC_RUNS_RETENTION_DAYS`, never a connection's latest finished one. */
  syncRuns: number;
  /** MCP tokens revoked or expired more than `MCP_TOKENS_RETENTION_DAYS` ago. */
  mcpTokens: number;
  /** MCP rate windows older than `MCP_RATE_WINDOWS_RETENTION_DAYS`. */
  mcpRateBuckets: number;
}

export interface RetentionRunResult {
  /** Workspaces processed (all of them unless the run was stopped). */
  workspaces: number;
  /** Failures, by step: a workspace's retention, a deleted workspace's audit trail, sign-in data. */
  failed: { workspaces: number; deletedOrgs: number; global: number };
  deletedPurged: number;
  /**
   * Usage rows of deleted workspaces: a run or chat turn still in flight when its workspace was
   * deleted can record usage after the purge (no foreign key to the workspace).
   */
  deletedUsage: number;
  /** Expired sessions and verifications deleted. */
  sessions: number;
  verifications: number;
  /** Invitations past `INVITATIONS_RETENTION_DAYS` (answered, withdrawn or long expired). */
  invitations: number;
  /** Export and deletion-attempt records past `PERSONAL_DATA_EXPORTS_RETENTION_DAYS`. */
  personalDataExports: number;
  /** Stripe event ids past `STRIPE_EVENTS_RETENTION_DAYS`. */
  stripeEvents: number;
  /** Sign-in attempt windows started more than `SIGN_IN_ATTEMPTS_RETENTION_DAYS` ago. */
  signInAttempts: number;
  /** The worker stopped during the run (the next run picks up the rest). */
  interrupted: boolean;
}

export type RetentionStep = 'workspace' | 'deleted_org' | 'expired_auth';

interface BatchOptions {
  signal?: AbortSignal;
  batchSize?: number;
}

/**
 * Runs `step` (deletes at most `size` rows, returns how many) until it deletes fewer than `size`,
 * checking the signal before every batch.
 */
async function drain(step: (size: number) => Promise<number>, opts: BatchOptions): Promise<number> {
  const size = opts.batchSize ?? RETENTION_BATCH_SIZE;
  let total = 0;
  for (;;) {
    if (opts.signal?.aborted) return total;
    const n = await step(size);
    total += n;
    if (n < size) return total;
  }
}

/** A batched delete in the workspace's RLS context, one short transaction per batch. */
const tenantDrain = (
  db: Db,
  orgId: string,
  opts: BatchOptions,
  step: (tx: Tx, size: number) => Promise<{ count: number }>,
) => drain((size) => withOrg(db, orgId, async (tx) => (await step(tx, size)).count), opts);

/** `purge_audit_log` until nothing is left (it deletes at most `size` rows per call). */
const auditDrain = (db: Db, orgId: string, before: Date, opts: BatchOptions) =>
  drain(
    (size) =>
      withOrg(db, orgId, async (tx) => {
        const [row] = await tx.execute<{ n: number }>(
          sql`select purge_audit_log(${orgId}, ${before.toISOString()}::timestamptz, ${size}::int) as n`,
        );
        return row?.n ?? 0;
      }),
    opts,
  );

/**
 * Applies one workspace's retention settings, in batches: idle conversations (their messages and
 * approvals cascade), finished skill runs with their reports (never queued or running ones, never
 * a skill's latest finished run), old usage records, skill-builder reservations and sync runs, MCP
 * tokens long revoked or expired and past MCP rate windows, and
 * audit entries through `purge_audit_log` (the only way the app role can delete audit rows). The
 * function's floor is a global 90 days; the workspace's own audit setting is applied here, as the
 * cutoff passed to it (P5 L25). Idempotent; a stopped worker (`signal`) ends it between batches.
 */
export async function applyRetention(
  db: Db,
  orgId: string,
  now: Date = new Date(),
  opts: BatchOptions = {},
): Promise<RetentionResult> {
  const s = await getWorkspaceSettings(db, orgId);
  const before = (days: number) => new Date(now.getTime() - days * DAY);

  const conversationsCutoff = before(s.conversationRetentionDays);
  const conversations = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(agentConversations).where(
      inArray(
        agentConversations.id,
        tx
          .select({ id: agentConversations.id })
          .from(agentConversations)
          .where(
            and(
              eq(agentConversations.orgId, orgId),
              lt(agentConversations.updatedAt, conversationsCutoff),
            ),
          )
          .limit(size),
      ),
    ),
  );

  // The daily caps count runs of the last 24 hours: the conversation period is at least 7 days.
  const newerRun = alias(skillRuns, 'newer_run');
  const skillRunsDeleted = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(skillRuns).where(
      inArray(
        skillRuns.id,
        tx
          .select({ id: skillRuns.id })
          .from(skillRuns)
          .where(
            and(
              eq(skillRuns.orgId, orgId),
              lt(skillRuns.createdAt, conversationsCutoff),
              inArray(skillRuns.status, [...FINISHED_RUNS]),
              // Keep each skill's latest finished run (the skill list shows it).
              or(
                isNull(skillRuns.skillId),
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(newerRun)
                    .where(
                      and(
                        eq(newerRun.skillId, skillRuns.skillId),
                        inArray(newerRun.status, [...FINISHED_RUNS]),
                        gt(newerRun.createdAt, skillRuns.createdAt),
                      ),
                    ),
                ),
              ),
            ),
          )
          .limit(size),
      ),
    ),
  );

  const usageCutoff = before(s.usageRetentionDays);
  const usage = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(agentUsage).where(
      inArray(
        agentUsage.id,
        tx
          .select({ id: agentUsage.id })
          .from(agentUsage)
          .where(and(eq(agentUsage.orgId, orgId), lt(agentUsage.createdAt, usageCutoff)))
          .limit(size),
      ),
    ),
  );

  const builderCutoff = before(BUILDER_CALLS_RETENTION_DAYS);
  const builderCalls = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(skillBuilderCalls).where(
      inArray(
        skillBuilderCalls.id,
        tx
          .select({ id: skillBuilderCalls.id })
          .from(skillBuilderCalls)
          .where(
            and(eq(skillBuilderCalls.orgId, orgId), lt(skillBuilderCalls.createdAt, builderCutoff)),
          )
          .limit(size),
      ),
    ),
  );

  const syncCutoff = before(SYNC_RUNS_RETENTION_DAYS);
  const newerSync = alias(jiraSyncRuns, 'newer_sync');
  const syncRuns = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(jiraSyncRuns).where(
      inArray(
        jiraSyncRuns.id,
        tx
          .select({ id: jiraSyncRuns.id })
          .from(jiraSyncRuns)
          .where(
            and(
              eq(jiraSyncRuns.orgId, orgId),
              lt(jiraSyncRuns.startedAt, syncCutoff),
              inArray(jiraSyncRuns.status, [...FINISHED_SYNCS]),
              // Keep each connection's latest finished run (the connection page shows it).
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(newerSync)
                  .where(
                    and(
                      eq(newerSync.connectionId, jiraSyncRuns.connectionId),
                      inArray(newerSync.status, [...FINISHED_SYNCS]),
                      gt(newerSync.startedAt, jiraSyncRuns.startedAt),
                    ),
                  ),
              ),
            ),
          )
          .limit(size),
      ),
    ),
  );

  const tokensCutoff = before(MCP_TOKENS_RETENTION_DAYS);
  const mcpTokensDeleted = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(mcpTokens).where(
      inArray(
        mcpTokens.id,
        tx
          .select({ id: mcpTokens.id })
          .from(mcpTokens)
          .where(
            and(
              eq(mcpTokens.orgId, orgId),
              or(lt(mcpTokens.revokedAt, tokensCutoff), lt(mcpTokens.expiresAt, tokensCutoff)),
            ),
          )
          .limit(size),
      ),
    ),
  );

  // Composite key (org, user, window): matched as a row value.
  const windowsCutoff = before(MCP_RATE_WINDOWS_RETENTION_DAYS);
  const mcpRateBucketsDeleted = await tenantDrain(db, orgId, opts, (tx, size) =>
    tx.delete(mcpRateBuckets).where(
      sql`(${mcpRateBuckets.userId}, ${mcpRateBuckets.windowStart}) in (${tx
        .select({ userId: mcpRateBuckets.userId, windowStart: mcpRateBuckets.windowStart })
        .from(mcpRateBuckets)
        .where(and(eq(mcpRateBuckets.orgId, orgId), lt(mcpRateBuckets.windowStart, windowsCutoff)))
        .limit(size)}) and ${mcpRateBuckets.orgId} = ${orgId}`,
    ),
  );

  const audit = await auditDrain(db, orgId, before(s.auditRetentionDays), opts);
  return {
    conversations,
    skillRuns: skillRunsDeleted,
    usage,
    audit,
    builderCalls,
    syncRuns,
    mcpTokens: mcpTokensDeleted,
    mcpRateBuckets: mcpRateBucketsDeleted,
  };
}

/**
 * Sessions and verifications more than a day past their expiry, old invitations, export and
 * deletion-attempt records, processed Stripe event ids and old sign-in attempt windows (not
 * tenant data). `expires_at`/`created_at` are timestamps without time zone holding UTC (better-auth
 * through drizzle), compared the same way.
 */
async function purgeExpiredAuth(db: Db, now: Date, opts: BatchOptions) {
  const cutoff = new Date(now.getTime() - EXPIRED_AUTH_GRACE_DAYS * DAY);
  const sessions = await drain(
    async (size) =>
      (
        await db
          .delete(session)
          .where(
            inArray(
              session.id,
              db
                .select({ id: session.id })
                .from(session)
                .where(lt(session.expiresAt, cutoff))
                .limit(size),
            ),
          )
      ).count,
    opts,
  );
  const verifications = await drain(
    async (size) =>
      (
        await db
          .delete(verification)
          .where(
            inArray(
              verification.id,
              db
                .select({ id: verification.id })
                .from(verification)
                .where(lt(verification.expiresAt, cutoff))
                .limit(size),
            ),
          )
      ).count,
    opts,
  );
  const invitationCutoff = new Date(now.getTime() - INVITATIONS_RETENTION_DAYS * DAY);
  const invitations = await drain(
    async (size) =>
      (
        await db.delete(invitation).where(
          inArray(
            invitation.id,
            db
              .select({ id: invitation.id })
              .from(invitation)
              .where(
                or(
                  and(ne(invitation.status, 'pending'), lt(invitation.createdAt, invitationCutoff)),
                  and(eq(invitation.status, 'pending'), lt(invitation.expiresAt, invitationCutoff)),
                ),
              )
              .limit(size),
          ),
        )
      ).count,
    opts,
  );
  const exportsCutoff = new Date(now.getTime() - PERSONAL_DATA_EXPORTS_RETENTION_DAYS * DAY);
  const personalDataExportsDeleted = await drain(
    async (size) =>
      (
        await db
          .delete(personalDataExports)
          .where(
            inArray(
              personalDataExports.id,
              db
                .select({ id: personalDataExports.id })
                .from(personalDataExports)
                .where(lt(personalDataExports.startedAt, exportsCutoff))
                .limit(size),
            ),
          )
      ).count,
    opts,
  );
  const stripeCutoff = new Date(now.getTime() - STRIPE_EVENTS_RETENTION_DAYS * DAY);
  const stripeEventsDeleted = await drain(
    async (size) =>
      (
        await db
          .delete(stripeEvents)
          .where(
            inArray(
              stripeEvents.id,
              db
                .select({ id: stripeEvents.id })
                .from(stripeEvents)
                .where(lt(stripeEvents.receivedAt, stripeCutoff))
                .limit(size),
            ),
          )
      ).count,
    opts,
  );
  const attemptsCutoff = new Date(now.getTime() - SIGN_IN_ATTEMPTS_RETENTION_DAYS * DAY);
  const signInAttemptsDeleted = await drain(
    async (size) =>
      (
        await db
          .delete(signInAttempts)
          .where(
            inArray(
              signInAttempts.keyHash,
              db
                .select({ keyHash: signInAttempts.keyHash })
                .from(signInAttempts)
                .where(lt(signInAttempts.windowStartedAt, attemptsCutoff))
                .limit(size),
            ),
          )
      ).count,
    opts,
  );
  return {
    sessions,
    verifications,
    invitations,
    personalDataExports: personalDataExportsDeleted,
    stripeEvents: stripeEventsDeleted,
    signInAttempts: signInAttemptsDeleted,
  };
}

/**
 * The daily retention run: every workspace's settings, expired sign-in data, then the audit trail
 * of workspaces deleted more than 90 days ago (only ids that are no longer a workspace). One
 * failure does not stop the rest; a stopped worker (`signal`) ends the run between batches.
 */
export async function runRetention(
  db: Db,
  opts: {
    now?: Date;
    signal?: AbortSignal;
    batchSize?: number;
    onError?: (error: unknown, step: RetentionStep, orgId?: string) => void;
  } = {},
): Promise<RetentionRunResult> {
  const now = opts.now ?? new Date();
  const batch: BatchOptions = { signal: opts.signal, batchSize: opts.batchSize };
  const result: RetentionRunResult = {
    workspaces: 0,
    failed: { workspaces: 0, deletedOrgs: 0, global: 0 },
    deletedPurged: 0,
    deletedUsage: 0,
    sessions: 0,
    verifications: 0,
    invitations: 0,
    personalDataExports: 0,
    stripeEvents: 0,
    signInAttempts: 0,
    interrupted: false,
  };
  const stopped = () => {
    result.interrupted = opts.signal?.aborted === true;
    return result.interrupted;
  };

  const orgs = await db.select({ id: organization.id }).from(organization);
  for (const { id } of orgs) {
    if (stopped()) return result;
    try {
      await applyRetention(db, id, now, batch);
    } catch (e) {
      result.failed.workspaces++;
      opts.onError?.(e, 'workspace', id);
    }
    result.workspaces++;
  }

  if (stopped()) return result;
  try {
    Object.assign(result, await purgeExpiredAuth(db, now, batch));
  } catch (e) {
    result.failed.global++;
    opts.onError?.(e, 'expired_auth');
  }

  // Every deleted workspace (not only the expired ones): usage written after its purge goes.
  const gone = await db
    .select({ id: deletedOrganizations.deletedOrgId })
    .from(deletedOrganizations)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(organization)
          .where(eq(organization.id, deletedOrganizations.deletedOrgId)),
      ),
    );
  for (const { id } of gone) {
    if (stopped()) return result;
    try {
      result.deletedUsage += await tenantDrain(db, id, batch, (tx, size) =>
        tx
          .delete(agentUsage)
          .where(
            inArray(
              agentUsage.id,
              tx
                .select({ id: agentUsage.id })
                .from(agentUsage)
                .where(eq(agentUsage.orgId, id))
                .limit(size),
            ),
          ),
      );
    } catch (e) {
      result.failed.deletedOrgs++;
      opts.onError?.(e, 'deleted_org', id);
    }
  }

  const expired = await db
    .select({ id: deletedOrganizations.deletedOrgId })
    .from(deletedOrganizations)
    .where(
      and(
        lt(deletedOrganizations.deletedAt, new Date(now.getTime() - DELETED_ORG_AUDIT_DAYS * DAY)),
        // An id that is still a workspace keeps its audit trail (stale or forged entry).
        notExists(
          db
            .select({ one: sql`1` })
            .from(organization)
            .where(eq(organization.id, deletedOrganizations.deletedOrgId)),
        ),
      ),
    );
  for (const { id } of expired) {
    if (stopped()) return result;
    try {
      // The cutoff is "now": the function still keeps the last 90 days.
      await auditDrain(db, id, now, batch);
      if (stopped()) return result;
      await db.delete(deletedOrganizations).where(eq(deletedOrganizations.deletedOrgId, id));
      result.deletedPurged++;
    } catch (e) {
      result.failed.deletedOrgs++;
      opts.onError?.(e, 'deleted_org', id);
    }
  }
  stopped();
  return result;
}
