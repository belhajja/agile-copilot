import { type Actor, assertCanManage, recordAudit } from '@agile/connections';
import {
  type Db,
  jiraBoards,
  jiraConnections,
  jiraSyncStates,
  organization,
  withOrg,
} from '@agile/db';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import type { SyncDeps } from './deps';
import { runSync, type SyncJob, type SyncOutcome } from './run-sync';

export const SYNC_QUEUE = 'jira-sync';
export const SYNC_TICK_QUEUE = 'jira-sync-tick';

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
  boss.on('error', opts.onError ?? (() => {}));
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
    if (!board) return 'no_boards' as const;
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
    return 'ok' as const;
  });
  if (check !== 'ok') return { ok: false, code: check };
  const id = await send(deps.boss, { orgId: actor.orgId, connectionId, trigger: 'manual' });
  return { ok: true, queued: id !== null };
}

/** Scheduled tick: queue a sync for every connection that has selected boards, in every workspace. */
export async function enqueueScheduledSyncs(deps: { db: Db; boss: PgBoss }): Promise<number> {
  // `organization` (better-auth) has no org_id column and no RLS: it is the list of tenants.
  const orgs = await deps.db.select({ id: organization.id }).from(organization);
  let sent = 0;
  for (const { id: orgId } of orgs) {
    const connections = await withOrg(deps.db, orgId, (tx) =>
      tx
        .selectDistinct({ connectionId: jiraBoards.connectionId })
        .from(jiraBoards)
        .where(eq(jiraBoards.selected, true)),
    );
    for (const { connectionId } of connections) {
      if (await send(deps.boss, { orgId, connectionId, trigger: 'schedule' })) sent++;
    }
  }
  return sent;
}

/** Cron expression for "every N minutes" (N divides 60). */
export const cronEvery = (minutes: number) =>
  minutes >= 60 ? '0 * * * *' : `*/${minutes} * * * *`;

/** Registers the sync workers and the recurring tick on a worker-role queue. */
export async function startSyncWorker(
  boss: PgBoss,
  deps: SyncDeps,
  opts: {
    intervalMinutes: number;
    concurrency?: number;
    onOutcome?: (job: SyncJob, outcome: SyncOutcome) => void;
  },
): Promise<void> {
  await boss.work<SyncJob>(
    SYNC_QUEUE,
    { batchSize: 1, localConcurrency: opts.concurrency ?? 2 },
    async ([job]) => {
      if (!job) return;
      const outcome = await runSync(deps, job.data);
      opts.onOutcome?.(job.data, outcome);
      return outcome;
    },
  );
  await boss.work(SYNC_TICK_QUEUE, async () => {
    await enqueueScheduledSyncs({ db: deps.db, boss });
  });
  await boss.schedule(SYNC_TICK_QUEUE, cronEvery(opts.intervalMinutes), null, { tz: 'UTC' });
}
