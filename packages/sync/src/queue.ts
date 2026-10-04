import { type Actor, assertCanManage, recordAudit } from '@agile/connections';
import {
  type Db,
  jiraBoards,
  jiraConnections,
  jiraSyncStates,
  organization,
  withOrg,
} from '@agile/db';
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { PERMANENT_CODES, RETRYABLE_CODES, type SyncDeps, type SyncFailureCode } from './deps';
import { runSync, type SyncJob, type SyncOutcome } from './run-sync';

export const SYNC_QUEUE = 'jira-sync';
export const SYNC_TICK_QUEUE = 'jira-sync-tick';
/**
 * pg-boss expires a sync job after this long (its signal aborts the run). Above the run's own
 * deadline (`RUN_DEADLINE_MS`, 25 min), so a run normally ends on its deadline and records it.
 */
export const SYNC_JOB_EXPIRE_SECONDS = 30 * 60;
/**
 * Sync jobs one worker process runs at once. At most one of them per workspace (F2): one tenant
 * with many connections (or a slow Jira) cannot hold every slot.
 */
export const SYNC_WORKER_CONCURRENCY = 4;

/** Options of the sync queue, also applied to a queue an earlier release created. */
const SYNC_QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: SYNC_JOB_EXPIRE_SECONDS,
};

/** What a queued job may carry: ids only, validated again by the worker (the queue is untrusted input). */
export const syncJobSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  trigger: z.enum(['manual', 'schedule']),
});

/** Thrown by the job handler so that pg-boss applies retryLimit/backoff. Carries the code only. */
export class RetryableSyncError extends Error {
  override name = 'RetryableSyncError';
  constructor(readonly code: SyncFailureCode) {
    super(`Jira sync will be retried: ${code}`);
  }
}

class InvalidSyncJobError extends Error {
  override name = 'InvalidSyncJobError';
  constructor() {
    super('Invalid sync job payload');
  }
}

/** Logs the error name only (messages may carry secrets). */
const logErrorName = (error: unknown) =>
  console.error(`[sync] ${error instanceof Error ? error.name : 'UnknownError'}`);

/**
 * Starts pg-boss as the app role in the `pgboss` schema (created by our migrations; pg-boss
 * installs and upgrades its own tables there) and makes sure both queues exist.
 * Producers (the web app) only send jobs: no maintenance, no cron.
 */
export async function startSyncQueue(
  connectionString: string,
  opts: { role: 'producer' | 'worker'; onError?: (error: Error) => void },
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    createSchema: false,
    max: opts.role === 'worker' ? 6 : 2,
    ...(opts.role === 'producer' ? { supervise: false, schedule: false } : {}),
  });
  // pg-boss emits 'error' for background failures; an unhandled 'error' event would crash the process.
  boss.on('error', opts.onError ?? logErrorName);
  await boss.start();
  // One queued-or-active sync per connection (singletonKey = connection id).
  await boss.createQueue(SYNC_QUEUE, { policy: 'exclusive', ...SYNC_QUEUE_OPTIONS });
  // createQueue leaves an existing queue as it was created (e.g. the earlier 1 h expiry).
  await boss.updateQueue(SYNC_QUEUE, SYNC_QUEUE_OPTIONS);
  await boss.createQueue(SYNC_TICK_QUEUE, {
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: 300,
  });
  return boss;
}

// Payloads carry ids only (never credentials); the worker re-reads everything under RLS. The
// workspace is the job's group: the worker runs one job per group at a time.
const send = (boss: PgBoss, job: SyncJob) =>
  boss.send(SYNC_QUEUE, { ...job }, { singletonKey: job.connectionId, group: { id: job.orgId } });

/** "Sync now": queues a sync unless one is already queued or running. */
export async function requestSync(
  deps: { db: Db; boss: PgBoss },
  actor: Actor,
  connectionId: string,
): Promise<{ ok: true; queued: boolean } | { ok: false; code: 'not_found' | 'no_boards' }> {
  assertCanManage(actor);
  const check = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId));
    if (!conn) return 'not_found' as const;
    const [board] = await tx
      .select({ id: jiraBoards.id })
      .from(jiraBoards)
      .where(and(eq(jiraBoards.connectionId, connectionId), eq(jiraBoards.selected, true)))
      .limit(1);
    if (!board) return 'no_boards' as const;
    // The database clock (run-sync stamps last_started_at with it): a run that starts after
    // this instant belongs to the job we are about to send.
    const [clock] = await tx.execute<{ requestedAt: string }>(sql`select now() as "requestedAt"`);
    if (!clock) throw new Error('database clock unavailable');
    // Kept as the driver's text (microsecond precision), compared as timestamptz below.
    return { requestedAt: clock.requestedAt };
  });
  if (typeof check === 'string') return { ok: false, code: check };
  // Send first: the state only says "queued" when a job really is. If send throws, nothing changed.
  const id = await send(deps.boss, { orgId: actor.orgId, connectionId, trigger: 'manual' });
  if (id === null) return { ok: true, queued: false }; // already queued or running
  await withOrg(deps.db, actor.orgId, async (tx) => {
    await tx
      .insert(jiraSyncStates)
      .values({ orgId: actor.orgId, connectionId, status: 'queued' })
      .onConflictDoUpdate({
        target: jiraSyncStates.connectionId,
        set: { status: 'queued' },
        // Never overwrite a run that already started after the request (it may even be finished).
        setWhere: and(
          ne(jiraSyncStates.status, 'running'),
          or(
            isNull(jiraSyncStates.lastStartedAt),
            lt(jiraSyncStates.lastStartedAt, sql`${check.requestedAt}::timestamptz`),
          ),
        ),
      });
    // The audit records that a sync was requested (the job was queued), whatever the state shows.
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_sync.requested',
      targetType: 'jira_connection',
      targetId: connectionId,
    });
  });
  return { ok: true, queued: true };
}

/** Scheduled tick: queue a sync for every connection that has selected boards, in every workspace. */
export async function enqueueScheduledSyncs(deps: {
  db: Db;
  boss: PgBoss;
  onError?: (error: unknown) => void;
}): Promise<number> {
  const report = deps.onError ?? logErrorName;
  // `organization` (better-auth) has no org_id column and no RLS: it is the list of tenants.
  const orgs = await deps.db.select({ id: organization.id }).from(organization);
  let sent = 0;
  for (const { id: orgId } of orgs) {
    try {
      const connections = await withOrg(deps.db, orgId, async (tx) => {
        const selected = await tx
          .selectDistinct({ connectionId: jiraBoards.connectionId })
          .from(jiraBoards)
          .where(eq(jiraBoards.selected, true));
        // Connections that failed for a reason only a user can fix wait for a manual "Sync now".
        const blocked = await tx
          .select({ connectionId: jiraSyncStates.connectionId })
          .from(jiraSyncStates)
          .where(inArray(jiraSyncStates.lastError, PERMANENT_CODES));
        const skip = new Set(blocked.map((b) => b.connectionId));
        return selected.filter((c) => !skip.has(c.connectionId));
      });
      for (const { connectionId } of connections) {
        if (await send(deps.boss, { orgId, connectionId, trigger: 'schedule' })) sent++;
      }
    } catch (error) {
      report(error); // one tenant's failure must not starve the others
    }
  }
  return sent;
}

const INTERVALS = [1, 5, 10, 15, 30, 60];

/** Cron expression for "every N minutes" (N in 1, 5, 10, 15, 30, 60). */
export function cronEvery(minutes: number): string {
  if (!INTERVALS.includes(minutes)) throw new RangeError('Unsupported sync interval');
  return minutes === 60 ? '0 * * * *' : `*/${minutes} * * * *`;
}

/**
 * One sync job. A malformed payload is reported and dropped (retrying cannot fix it). Retryable
 * failures throw so pg-boss retries with backoff; permanent ones are final (the code is stored).
 */
export async function handleSyncJob(
  deps: SyncDeps,
  data: unknown,
  opts: {
    onOutcome?: (job: SyncJob, outcome: SyncOutcome) => void;
    onError?: (error: unknown) => void;
    /** The job's own signal (pg-boss aborts it on expiry or stop); combined with deps.signal. */
    signal?: AbortSignal;
  } = {},
): Promise<SyncOutcome | undefined> {
  const parsed = syncJobSchema.safeParse(data);
  if (!parsed.success) {
    (opts.onError ?? logErrorName)(new InvalidSyncJobError());
    return undefined;
  }
  const signals = [deps.signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const outcome = await runSync({ ...deps, signal }, parsed.data);
  opts.onOutcome?.(parsed.data, outcome);
  if (!outcome.ok && RETRYABLE_CODES.has(outcome.code)) throw new RetryableSyncError(outcome.code);
  return outcome;
}

/** Registers the sync workers and the recurring tick on a worker-role queue. */
export async function startSyncWorker(
  boss: PgBoss,
  deps: SyncDeps,
  opts: {
    intervalMinutes: number;
    concurrency?: number;
    onOutcome?: (job: SyncJob, outcome: SyncOutcome) => void;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  await boss.work<SyncJob>(
    SYNC_QUEUE,
    {
      batchSize: 1,
      localConcurrency: opts.concurrency ?? SYNC_WORKER_CONCURRENCY,
      // One active job per workspace in this process: a job of a busy workspace stays queued
      // (pg-boss skips its group, or puts it back untouched) and other workspaces take the slots.
      // Strict per process; across worker replicas runSync's workspace lease is the backstop.
      localGroupConcurrency: 1,
    },
    async ([job]) => {
      if (!job) return;
      return handleSyncJob(deps, job.data, { ...opts, signal: job.signal });
    },
  );
  await boss.work(SYNC_TICK_QUEUE, async () => {
    // The tick carries no data; never read it.
    await enqueueScheduledSyncs({ db: deps.db, boss, onError: opts.onError });
  });
  await boss.schedule(SYNC_TICK_QUEUE, cronEvery(opts.intervalMinutes), null, { tz: 'UTC' });
}
