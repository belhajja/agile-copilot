import type { Db } from '@agile/db';
import type { PgBoss } from 'pg-boss';
import { type RetentionRunResult, runRetention } from './retention';

export const RETENTION_QUEUE = 'privacy-retention';
/** Daily, at night UTC. */
export const RETENTION_CRON = '30 3 * * *';

/**
 * Registers the daily retention job on the worker's pg-boss (one run at a time; a re-run is
 * harmless: every delete is by age). Worker shutdown (`signal`) or job expiry ends the run
 * between workspaces.
 */
export async function startRetentionWorker(
  boss: PgBoss,
  deps: { db: Db; onError?: (error: unknown, orgId: string) => void },
  opts: { signal?: AbortSignal; onDone?: (result: RetentionRunResult) => void } = {},
): Promise<void> {
  await boss.createQueue(RETENTION_QUEUE, {
    policy: 'exclusive',
    retryLimit: 1,
    expireInSeconds: 3600,
  });
  await boss.work(RETENTION_QUEUE, async ([job]) => {
    // The scheduled job carries no data; never read it.
    const signals = [opts.signal, job?.signal].filter((s): s is AbortSignal => s !== undefined);
    const result = await runRetention(deps.db, {
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      onError: deps.onError,
    });
    opts.onDone?.(result);
  });
  await boss.schedule(RETENTION_QUEUE, RETENTION_CRON, null, { tz: 'UTC' });
}
