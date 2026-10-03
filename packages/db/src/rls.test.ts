import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
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
    await expect(
      withOrg(app.db, 'org_a', (tx) => tx.update(auditLog).set({ action: 'tampered' })),
    ).rejects.toSatisfy((e: unknown) => /permission denied/.test(pgMessage(e)));
  });

  it('guards the schema: every public table with org_id has forced RLS and a policy', async () => {
    const rows = (await app.db.execute(sql`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = c.relname
            and col.column_name = 'org_id')
      order by c.relname
    `)) as unknown as { table: string; rls: boolean; forced: boolean; policies: number }[];
    expect(rows.length).toBeGreaterThan(0);
    const unguarded = rows.filter((r) => !r.rls || !r.forced || r.policies < 1);
    expect(unguarded).toEqual([]);
  });

  it('refuses an empty org id', () => {
    expect(() => withOrg(app.db, '', async () => 1)).toThrow(/non-empty/);
  });
});
