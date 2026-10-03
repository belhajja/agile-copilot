import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withOrg } from './client';
import { auditLog, jiraConnections } from './schema';
import { startTestDatabase, type TestDatabase } from './testing';

const pgMessage = (e: unknown): string =>
  e instanceof Error ? `${e.message} ${(e.cause as Error | undefined)?.message ?? ''}` : String(e);

const connectionRow = (orgId: string) => ({
  id: randomUUID(),
  orgId,
  name: 'Jira',
  deployment: 'datacenter' as const,
  authType: 'pat' as const,
  baseUrl: `https://jira.${orgId}.example/${randomUUID()}`,
  secret: 's1.x.y.z',
  createdBy: 'user_1',
});

describe('row-level security (as app_user)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 1 }); // one connection: proves org context doesn't leak
  });
  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('shows each org only its own rows', async () => {
    await withOrg(app.db, 'org_a', (tx) =>
      tx.insert(jiraConnections).values(connectionRow('org_a')),
    );
    await withOrg(app.db, 'org_b', (tx) =>
      tx.insert(jiraConnections).values(connectionRow('org_b')),
    );
    const seenByA = await withOrg(app.db, 'org_a', (tx) => tx.select().from(jiraConnections));
    expect(seenByA.map((r) => r.orgId)).toEqual(['org_a']);
  });

  it('shows nothing outside withOrg, even on a connection that just ran withOrg', async () => {
    await withOrg(app.db, 'org_a', (tx) => tx.select().from(jiraConnections));
    expect(await app.db.select().from(jiraConnections)).toEqual([]);
  });

  it("rejects writing another org's row", async () => {
    await expect(
      withOrg(app.db, 'org_a', (tx) => tx.insert(jiraConnections).values(connectionRow('org_b'))),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(pgMessage(e)));
  });

  it('keeps the audit log append-only', async () => {
    await withOrg(app.db, 'org_a', (tx) =>
      tx.insert(auditLog).values({ orgId: 'org_a', action: 'test' }),
    );
    await expect(withOrg(app.db, 'org_a', (tx) => tx.delete(auditLog))).rejects.toSatisfy(
      (e: unknown) => /permission denied/.test(pgMessage(e)),
    );
  });

  it('refuses an empty org id', () => {
    expect(() => withOrg(app.db, '', async () => 1)).toThrow(/non-empty/);
  });
});
