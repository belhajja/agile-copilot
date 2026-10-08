import 'server-only';
import { errorName, log } from '@agile/observability/log';
import type { SyncDeps } from '@agile/sync';
import { startSyncQueue } from '@agile/sync';
import type { PgBoss } from 'pg-boss';
import { atlassianOAuth } from './atlassian';
import { connectionDeps, services } from './context';

/** Dependencies of the sync services (board discovery needs to refresh OAuth tokens too). */
export function syncDeps(): SyncDeps {
  return {
    ...connectionDeps(),
    oauth: atlassianOAuth() ?? undefined,
    // Code and error name only: Jira error messages may carry tokens or URLs.
    onError: (error, code) => log('warn', 'sync_error', { code, error: errorName(error) }),
  };
}

// One pg-boss producer per server process, kept across dev hot-reloads like the db pool.
const g = globalThis as unknown as { __agileSyncQueue?: Promise<PgBoss> };

/** Lazily started job producer used by "Sync now" (the worker app runs the jobs). */
export function syncQueue(): Promise<PgBoss> {
  g.__agileSyncQueue ??= startSyncQueue(services().env.DATABASE_URL, {
    role: 'producer',
    onError: (error) => log('error', 'queue_error', { error: error.name }),
  }).catch((error: unknown) => {
    g.__agileSyncQueue = undefined; // retry on the next request
    throw error;
  });
  return g.__agileSyncQueue;
}
