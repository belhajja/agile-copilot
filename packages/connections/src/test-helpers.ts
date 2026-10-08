import { parseKeyring } from '@agile/crypto';
import { type Actor, createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import type { JiraCredentials, JiraTestResult } from '@agile/jira';

export const keyring = parseKeyring(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
export const owner = (orgId = 'org_a'): Actor => ({
  orgId,
  userId: `user_${orgId}`,
  roles: ['owner'],
});
/** The non-admin roles: neither manages connections (connections.manage is owner/admin). */
export const viewer = (orgId = 'org_a'): Actor => ({ orgId, userId: 'user_v', roles: ['viewer'] });
export const manager = (orgId = 'org_a'): Actor => ({
  orgId,
  userId: 'user_mgr',
  roles: ['manager'],
});

export const okJira =
  (displayName = 'Pat') =>
  async (c: JiraCredentials): Promise<JiraTestResult> => ({
    ok: true,
    deployment: c.kind === 'datacenter_pat' ? 'datacenter' : 'cloud',
    version: '10.3.0',
    account: { id: 'acc-1', displayName },
  });

export async function startHarness() {
  const tdb: TestDatabase = await startTestDatabase();
  const app = createDb(tdb.appUrl, { max: 4 });
  const owner_ = createDb(tdb.ownerUrl, { max: 1 }); // bypasses RLS, for inspecting raw rows
  return {
    db: app.db,
    rawDb: owner_.db,
    stop: async () => {
      await app.close();
      await owner_.close();
      await tdb.stop();
    },
  };
}
