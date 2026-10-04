import 'server-only';
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
    onError: (error, code) =>
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'sync_error',
          code,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      ),
  };
}

// One pg-boss producer per server process, kept across dev hot-reloads like the db pool.
const g = globalThis as unknown as { __agileSyncQueue?: Promise<PgBoss> };

/** Lazily started job producer used by "Sync now" (the worker app runs the jobs). */
export function syncQueue(): Promise<PgBoss> {
  g.__agileSyncQueue ??= startSyncQueue(services().env.DATABASE_URL, {
    role: 'producer',
    onError: (error) =>
      console.error(JSON.stringify({ level: 'error', event: 'queue_error', error: error.name })),
  }).catch((error: unknown) => {
    g.__agileSyncQueue = undefined; // retry on the next request
    throw error;
  });
  return g.__agileSyncQueue;
}
