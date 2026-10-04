import { parseKeyring } from '@agile/crypto';
import { createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import type { JiraCredentials, JiraTestResult } from '@agile/jira';
import type { Actor } from './actor';

export const keyring = parseKeyring(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
export const owner = (orgId = 'org_a'): Actor => ({
  orgId,
  userId: `user_${orgId}`,
  roles: ['owner'],
});
export const member = (orgId = 'org_a'): Actor => ({ orgId, userId: 'user_m', roles: ['member'] });

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
