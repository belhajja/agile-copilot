import type { WorkerEnv } from '@agile/config';
import { parseKeyring } from '@agile/crypto';
import { createDb } from '@agile/db';
import { createAtlassianOAuth } from '@agile/jira';
import { SYNC_QUEUE, type SyncDeps, startSyncQueue, startSyncWorker } from '@agile/sync';
import { sql } from 'drizzle-orm';
import { startHealthServer } from './health';
import type { Logger } from './log';

export interface RunningWorker {
  healthPort: number;
  /** Aborted when the worker stops: running syncs end as `interrupted` between pages. */
  signal: AbortSignal;
  stop(): Promise<void>;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

/** Wires the sync workers (pg-boss) and the health endpoint. */
export async function startWorker(env: WorkerEnv, log: Logger): Promise<RunningWorker> {
  const { db, close } = createDb(env.DATABASE_URL, { max: 5 });
  const shutdown = new AbortController();
  let boss: Awaited<ReturnType<typeof startSyncQueue>> | undefined;
  let health: Awaited<ReturnType<typeof startHealthServer>> | undefined;
  try {
    const oauth =
      env.ATLASSIAN_OAUTH_CLIENT_ID && env.ATLASSIAN_OAUTH_CLIENT_SECRET
        ? createAtlassianOAuth({
            clientId: env.ATLASSIAN_OAUTH_CLIENT_ID,
            clientSecret: env.ATLASSIAN_OAUTH_CLIENT_SECRET,
            redirectUri: new URL('/api/jira/oauth/callback', env.BETTER_AUTH_URL).toString(),
          })
        : undefined;
    const deps: SyncDeps = {
      db,
      keyring: parseKeyring(env.ENCRYPTION_KEYS),
      allowedPrivateHosts: env.ALLOWED_PRIVATE_HOSTS,
      oauth,
      signal: shutdown.signal,
      // Code and error name only: messages may carry Jira tokens or URLs.
      onError: (error, code) => log('warn', 'sync_error', { code, error: errorName(error) }),
    };
    const started = await startSyncQueue(env.DATABASE_URL, {
      role: 'worker',
      onError: (error) => log('error', 'queue_error', { error: error.name }),
    });
    boss = started;
    await startSyncWorker(started, deps, {
      intervalMinutes: env.SYNC_INTERVAL_MINUTES,
      onError: (error) => log('error', 'job_error', { error: errorName(error) }),
      onOutcome: (job, outcome) =>
        log(outcome.ok ? 'info' : 'warn', 'sync_finished', {
          orgId: job.orgId,
          connectionId: job.connectionId,
          trigger: job.trigger,
          ...(outcome.ok
            ? { mode: outcome.mode, boards: outcome.boards, issues: outcome.issues }
            : { code: outcome.code }),
        }),
    });
    // Ready = the database answers and the job queue is reachable through pg-boss.
    health = await startHealthServer(env.WORKER_HEALTH_PORT, env.WORKER_HEALTH_HOST, async () => {
      await db.execute(sql`select 1`);
      return (await started.getQueue(SYNC_QUEUE)) !== null;
    });
    log('info', 'worker_started', {
      healthPort: health.port,
      syncIntervalMinutes: env.SYNC_INTERVAL_MINUTES,
      oauth: Boolean(oauth),
    });
  } catch (error) {
    // Startup failed half-way: release what was opened so the process can exit.
    await health?.close().catch(() => undefined);
    await boss?.stop({ graceful: false }).catch(() => undefined);
    await close().catch(() => undefined);
    throw error;
  }
  const runningBoss = boss;
  const runningHealth = health;
  return {
    healthPort: runningHealth.port,
    signal: shutdown.signal,
    stop: async () => {
      // Running syncs stop at their next page and release their lease (a retry takes over).
      shutdown.abort();
      try {
        await runningHealth.close();
        // Lets running syncs finish (up to 30 s), then closes pg-boss's pool.
        await runningBoss.stop({ graceful: true, timeout: 30_000 });
      } finally {
        await close();
      }
    },
  };
}
