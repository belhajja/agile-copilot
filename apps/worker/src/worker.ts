import { type AutomationDeps, SKILL_RUN_QUEUE, startSkillWorker } from '@agile/automation';
import type { WorkerEnv } from '@agile/config';
import { parseKeyring } from '@agile/crypto';
import { createDb } from '@agile/db';
import { createAtlassianOAuth } from '@agile/jira';
import { errorName, type Logger } from '@agile/observability/log';
import { RETENTION_QUEUE, startRetentionWorker } from '@agile/privacy';
import { SYNC_QUEUE, type SyncDeps, startSyncQueue, startSyncWorker } from '@agile/sync';
import { sql } from 'drizzle-orm';
import { startHealthServer } from './health';

/**
 * On stop, how long pg-boss waits for running jobs: above the longest skill run plus delivery
 * (`SKILL_RUN_MAX_MS`, 180 s), so a run aborted mid-delivery can still record its outcome (M3).
 */
export const WORKER_STOP_TIMEOUT_MS = 190_000;
/** The process exits anyway after this long (main.ts); below compose's `stop_grace_period` (200 s). */
export const WORKER_STOP_BACKSTOP_MS = 195_000;

export interface RunningWorker {
  healthPort: number;
  /** Aborted when the worker stops: running syncs end as `interrupted` between pages. */
  signal: AbortSignal;
  stop(): Promise<void>;
}

/** Wires the sync, skill and retention workers (pg-boss) and the health endpoint. */
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
    const { onError: _syncLog, ...shared } = deps;
    const automation: AutomationDeps = {
      ...shared,
      // Skill runs read Jira through the read-only twin only (never the read-write instance).
      mcpAtlassianReadonlyUrl: env.MCP_ATLASSIAN_READONLY_URL,
      appUrl: env.BETTER_AUTH_URL,
      dailyLimit: env.SKILL_RUNS_DAILY_LIMIT,
      // Code and error name only: messages may carry provider bodies, Jira content or secrets.
      onError: (error, code) => log('warn', 'skill_error', { code, error: errorName(error) }),
    };
    await startSkillWorker(started, automation, {
      signal: shutdown.signal,
      onError: (error) => log('error', 'skill_job_error', { error: errorName(error) }),
      onOutcome: (job, outcome) =>
        log(outcome.status === 'succeeded' ? 'info' : 'warn', 'skill_run_finished', {
          orgId: job.orgId,
          runId: job.runId,
          status: outcome.status,
          ...('code' in outcome ? { code: outcome.code } : {}),
        }),
    });
    // Daily data retention (conversations, skill runs, usage, audit) for every workspace.
    await startRetentionWorker(
      started,
      {
        db,
        // Step, workspace id and error name only.
        onError: (error, step, orgId) =>
          log('warn', 'retention_failed', { step, orgId: orgId ?? null, error: errorName(error) }),
      },
      {
        // A stopping worker ends the run between workspaces (the next run picks up the rest).
        signal: shutdown.signal,
        onDone: ({ failed, ...counts }) =>
          log('info', 'retention_finished', {
            ...counts,
            failedWorkspaces: failed.workspaces,
            failedDeletedOrgs: failed.deletedOrgs,
            failedGlobal: failed.global,
          }),
      },
    );
    // Ready = the database answers and the job queues are reachable through pg-boss.
    health = await startHealthServer(env.WORKER_HEALTH_PORT, env.WORKER_HEALTH_HOST, async () => {
      await db.execute(sql`select 1`);
      return (
        (await started.getQueue(SYNC_QUEUE)) !== null &&
        (await started.getQueue(SKILL_RUN_QUEUE)) !== null &&
        (await started.getQueue(RETENTION_QUEUE)) !== null
      );
    });
    log('info', 'worker_started', {
      healthPort: health.port,
      syncIntervalMinutes: env.SYNC_INTERVAL_MINUTES,
      oauth: Boolean(oauth),
      liveJiraInRuns: Boolean(env.MCP_ATLASSIAN_READONLY_URL),
      skillRunsDailyLimit: env.SKILL_RUNS_DAILY_LIMIT,
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
        // Lets running syncs and runs (aborted above) record their outcome, then closes pg-boss's pool.
        await runningBoss.stop({ graceful: true, timeout: WORKER_STOP_TIMEOUT_MS });
      } finally {
        await close();
      }
    },
  };
}
