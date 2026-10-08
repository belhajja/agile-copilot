import { createJiraConnection } from '@agile/connections';
import { parseKeyring } from '@agile/crypto';
import { type Actor, createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import {
  demoDataset,
  type MockJira,
  type MockJiraOptions,
  startMockJira,
} from '@agile/jira/testing';
import type { SyncDeps } from './deps';

export const keyring = parseKeyring(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
export const owner = (orgId = 'org_a'): Actor => ({
  orgId,
  userId: `user_${orgId}`,
  roles: ['owner'],
});
/** A workspace viewer: reads dashboards, changes nothing. */
export const viewer = (orgId = 'org_a'): Actor => ({ orgId, userId: 'user_m', roles: ['viewer'] });
/** @deprecated The retired `member` role is gone: other packages' tests still import this alias. */
export const member = viewer;
export const manager = (orgId = 'org_a'): Actor => ({
  orgId,
  userId: 'user_mgr',
  roles: ['manager'],
});

export const ANCHOR = new Date('2026-10-04T00:00:00Z');
export const NOW = new Date('2026-10-04T08:00:00Z');

/** Postgres (Testcontainers) + a Data Center mock Jira serving the demo dataset. */
export async function startSyncHarness(mockOpts: Partial<MockJiraOptions> = {}) {
  const tdb: TestDatabase = await startTestDatabase();
  const app = createDb(tdb.appUrl, { max: 4 });
  const raw = createDb(tdb.ownerUrl, { max: 1 }); // bypasses RLS, to inspect rows
  const dataset = demoDataset(ANCHOR);
  const mock: MockJira = await startMockJira({
    flavor: 'datacenter',
    validAuthorization: 'Bearer good-pat',
    dataset,
    now: () => NOW,
    ...mockOpts,
  });
  const deps: SyncDeps = {
    db: app.db,
    keyring,
    allowedPrivateHosts: ['127.0.0.1'],
    retry: { sleep: async () => {} },
    now: () => NOW,
  };
  /** Creates (and tests) a DC connection to the mock; returns its id. */
  const connect = async (actor = owner(), name = 'Corp Jira') => {
    const r = await createJiraConnection(deps, actor, {
      name,
      credentials: { kind: 'datacenter_pat', baseUrl: mock.url, token: 'good-pat' },
    });
    if (!r.ok) throw new Error(`connect failed: ${r.code}`);
    return r.connection.id;
  };
  return {
    tdb,
    db: app.db,
    rawDb: raw.db,
    dataset,
    mock,
    deps,
    connect,
    stop: async () => {
      await mock.close();
      await app.close();
      await raw.close();
      await tdb.stop();
    },
  };
}
