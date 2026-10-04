import { type Actor, assertCanManage, recordAudit } from '@agile/connections';
import {
  type Db,
  jiraBoards,
  jiraConnections,
  jiraSyncStates,
  organization,
  withOrg,
} from '@agile/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { SyncDeps, SyncFailureCode } from './deps';
import { runSync, type SyncJob, type SyncOutcome } from './run-sync';

export const SYNC_QUEUE = 'jira-sync';
export const SYNC_TICK_QUEUE = 'jira-sync-tick';

/** What a queued job may carry: ids only, validated again by the worker (the queue is untrusted input). */
export const syncJobSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  trigger: z.enum(['manual', 'schedule']),
});

/** Failures worth retrying with backoff; everything else is stored on the sync state and final. */
const RETRYABLE_CODES: ReadonlySet<SyncFailureCode> = new Set(['rate_limited', 'unreachable']);
/** Failures that need a user action: the scheduled tick skips them until a manual "Sync now". */
const PERMANENT_CODES = [
  'unauthorized',
  'forbidden',
  'oauth_expired',
  'oauth_unavailable',
  'blocked_url',
];

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
    max: opts.role === 'worker' ? 4 : 2,
    ...(opts.role === 'producer' ? { supervise: false, schedule: false } : {}),
  });
  // pg-boss emits 'error' for background failures; an unhandled 'error' event would crash the process.
  boss.on('error', opts.onError ?? logErrorName);
  await boss.start();
  // One queued-or-active sync per connection (singletonKey = connection id).
  await boss.createQueue(SYNC_QUEUE, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 3600,
  });
  await boss.createQueue(SYNC_TICK_QUEUE, {
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: 300,
  });
  return boss;
}

// Payloads carry ids only (never credentials); the worker re-reads everything under RLS.
const send = (boss: PgBoss, job: SyncJob) =>
  boss.send(SYNC_QUEUE, { ...job }, { singletonKey: job.connectionId });

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
    return board ? ('ok' as const) : ('no_boards' as const);
  });
  if (check !== 'ok') return { ok: false, code: check };
  // Send first: the state only says "queued" when a job really is. If send throws, nothing changed.
  const id = await send(deps.boss, { orgId: actor.orgId, connectionId, trigger: 'manual' });
  if (id === null) return { ok: true, queued: false }; // already queued or running
  await withOrg(deps.db, actor.orgId, async (tx) => {
    await tx
      .insert(jiraSyncStates)
      .values({ orgId: actor.orgId, connectionId, status: 'queued' })
      .onConflictDoUpdate({
        target: jiraSyncStates.connectionId,
        // A running sync keeps showing as running.
        set: {
          status: sql`case when ${jiraSyncStates.status} = 'running' then 'running'::sync_status else 'queued'::sync_status end`,
        },
      });
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
  } = {},
): Promise<SyncOutcome | undefined> {
  const parsed = syncJobSchema.safeParse(data);
  if (!parsed.success) {
    (opts.onError ?? logErrorName)(new InvalidSyncJobError());
    return undefined;
  }
  const outcome = await runSync(deps, parsed.data);
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
    { batchSize: 1, localConcurrency: opts.concurrency ?? 2 },
    async ([job]) => {
      if (!job) return;
      return handleSyncJob(deps, job.data, opts);
    },
  );
  await boss.work(SYNC_TICK_QUEUE, async () => {
    // The tick carries no data; never read it.
    await enqueueScheduledSyncs({ db: deps.db, boss, onError: opts.onError });
  });
  await boss.schedule(SYNC_TICK_QUEUE, cronEvery(opts.intervalMinutes), null, { tz: 'UTC' });
}
