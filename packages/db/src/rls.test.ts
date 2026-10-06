import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withOrg } from './client';
import { purgeOrgTenantRows } from './purge';
import { auditLog, jiraConnections, orgDataKeys } from './schema';
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
  let owner: ReturnType<typeof createDb>; // bypasses RLS, to inspect raw rows

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 1 }); // one connection: proves org context doesn't leak
    owner = createDb(tdb.ownerUrl, { max: 1 });
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
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

  it('guards the schema: foreign keys from tenant tables cascade on delete', async () => {
    // purgeOrgTenantRows deletes table by table in any order, which only works with cascades.
    const rows = (await app.db.execute(sql`
      select con.conname as name, con.confdeltype as on_delete
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
      where con.contype = 'f' and n.nspname = 'public'
        and exists (select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = rel.relname
            and col.column_name = 'org_id')
    `)) as unknown as { name: string; on_delete: string }[];
    // The allowed exceptions are SET NULL, and purge works in any order since it only nulls a
    // column: a skill run outlives its channel and its skill (the daily caps count it, P4-R31); a
    // conversation outlives the model picked for it (back to the default) and its group.
    const setNullAllowed = [
      'skill_runs_channel_id_delivery_channels_id_fk',
      'skill_runs_skill_id_skills_id_fk',
      'agent_conversations_llm_connection_id_llm_connections_id_fk',
      'agent_conversations_group_id_agent_conversation_groups_id_fk',
    ];
    expect(
      rows.filter(
        (r) => r.on_delete !== 'c' && !(r.on_delete === 'n' && setNullAllowed.includes(r.name)),
      ),
    ).toEqual([]);
  });

  it('guards the schema: every cascading or set-null foreign key is covered by an index', async () => {
    // Without one, each parent delete scans the child table: deleting a connection turns quadratic.
    // Partial indexes cannot serve the FK lookup, so they do not count.
    const rows = (await app.db.execute(sql`
      select con.conname as name
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
      where con.contype = 'f' and con.confdeltype in ('c', 'n') and n.nspname = 'public'
        and not exists (
          select 1 from pg_index i
          where i.indrelid = con.conrelid and i.indpred is null
            and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey
            and con.conkey @> (i.indkey::int2[])[0:cardinality(con.conkey) - 1]
        )
      order by con.conname
    `)) as unknown as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it('purges one org from every tenant table except the audit log', async () => {
    for (const org of ['org_p', 'org_q']) {
      await withOrg(app.db, org, async (tx) => {
        await tx.insert(jiraConnections).values(connectionRow(org));
        await tx.insert(orgDataKeys).values({ orgId: org, kekVersion: 1, wrappedDek: 'w' });
        await tx.insert(auditLog).values({ orgId: org, action: 'test' });
      });
    }
    const purged = await withOrg(app.db, 'org_p', (tx) => purgeOrgTenantRows(tx, 'org_p'));
    expect(purged).toEqual(
      expect.arrayContaining(['jira_connections', 'llm_connections', 'org_data_keys']),
    );
    expect(purged).not.toContain('audit_log');

    const count = async (org: string) =>
      (await owner.db.execute(sql`
        select (select count(*)::int from jira_connections where org_id = ${org}) as jira,
               (select count(*)::int from org_data_keys where org_id = ${org}) as keys,
               (select count(*)::int from audit_log where org_id = ${org}) as audit
      `)) as unknown as { jira: number; keys: number; audit: number }[];
    expect(await count('org_p')).toEqual([{ jira: 0, keys: 0, audit: 1 }]);
    expect(await count('org_q')).toEqual([{ jira: 1, keys: 1, audit: 1 }]);
  });

  it('refuses an empty org id', () => {
    expect(() => withOrg(app.db, '', async () => 1)).toThrow(/non-empty/);
  });
});
