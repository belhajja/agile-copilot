import { auditLog, createDb, user } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_PAGE,
  csvCell,
  exportAuditLog,
  openAuditExport,
  recentAuditEntries,
} from './audit-export';
import { EXPORTS_PER_HOUR } from './gdpr';

const admin = { orgId: 'org_a', userId: 'u_admin', roles: ['admin'] };

describe('audit log export', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  const ROWS = AUDIT_EXPORT_PAGE * 2 + 500;

  const collect = async (gen: AsyncGenerator<string>) => {
    let out = '';
    for await (const c of gen) out += c;
    return out;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    await raw.db
      .insert(user)
      .values({ id: 'u_admin', name: 'Ada Admin', email: 'ada@example.com' });
    // Many entries sharing one timestamp: pages must split them without repeats or gaps.
    await raw.db.execute(sql`
      insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata, created_at)
      select 'org_a', 'u_admin', 'jira_sync.requested', 'jira_connection', 'c' || g,
             jsonb_build_object('n', g), timestamptz '2026-09-01 10:00:00.123456+00'
      from generate_series(1, ${ROWS}) g`);
    await raw.db.insert(auditLog).values([
      {
        orgId: 'org_a',
        action: 'member.joined',
        targetType: 'user',
        targetId: '=HYPERLINK("http://evil.example")',
        metadata: { note: 'a "quoted", multi\nline value' },
        createdAt: new Date('2026-09-20T00:00:00Z'),
      },
      { orgId: 'org_b', action: 'secret.of.b', createdAt: new Date('2026-09-02T00:00:00Z') },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await raw?.close();
    await tdb?.stop();
  });

  it('is for owners and admins only', async () => {
    for (const roles of [['manager'], ['viewer'], []]) {
      await expect(
        exportAuditLog(app.db, { ...admin, roles }, { format: 'csv' }),
      ).rejects.toMatchObject({ code: 'forbidden_role' });
      await expect(recentAuditEntries(app.db, { ...admin, roles })).rejects.toMatchObject({
        code: 'forbidden_role',
      });
    }
  });

  it('streams every entry of the workspace once, oldest first, as JSON Lines', async () => {
    const text = await collect(await exportAuditLog(app.db, admin, { format: 'json' }));
    const lines = text
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    // The seeded rows, the injected one, and the export's own audit entry.
    expect(lines).toHaveLength(ROWS + 2);
    const targets = lines.map((l) => l.target_id);
    expect(new Set(targets).size).toBe(targets.length);
    expect(lines.map((l) => l.action)).not.toContain('secret.of.b');
    expect(lines[0]).toMatchObject({
      action: 'jira_sync.requested',
      actor_name: 'Ada Admin',
      actor_email: 'ada@example.com',
    });
    expect(lines.at(-1)?.action).toBe('audit.exported');
  });

  it('writes CSV that spreadsheets cannot run, within a date range', async () => {
    const text = await collect(
      await exportAuditLog(app.db, admin, {
        format: 'csv',
        from: new Date('2026-09-10T00:00:00Z'),
        to: new Date('2026-09-30T00:00:00Z'),
      }),
    );
    expect(text).toBe(
      'created_at,action,actor_user_id,actor_name,actor_email,target_type,target_id,metadata\r\n' +
        '2026-09-20T00:00:00.000Z,member.joined,,,,user,' +
        `"'=HYPERLINK(""http://evil.example"")",` +
        '"{""note"":""a \\""quoted\\"", multi\\nline value""}"\r\n',
    );
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(null)).toBe('');
  });

  it('records every export in the audit log', async () => {
    const recent = await recentAuditEntries(app.db, admin, 5);
    expect(recent[0]).toMatchObject({ action: 'audit.exported', actorUserId: 'u_admin' });
    expect(recent[0]?.metadata).toMatchObject({ format: 'csv', from: '2026-09-10T00:00:00.000Z' });
  });

  it('keeps one JSON Lines record on one line, even with U+2028 and newlines', async () => {
    await raw.db.insert(auditLog).values({
      orgId: 'org_c',
      action: 'x.y',
      metadata: { note: 'a\u2028b\u2029c\nd' },
      createdAt: new Date('2026-09-25T00:00:00Z'),
    });
    const text = await collect(
      await exportAuditLog(
        app.db,
        { ...admin, orgId: 'org_c' },
        { format: 'json', from: new Date('2026-09-25T00:00:00Z') },
      ),
    );
    expect(text).not.toMatch(/[\u2028\u2029]/);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '').metadata.note).toBe('a\u2028b\u2029c\nd');
  });

  it('throttles the route entry point: one running, a few per hour, owners and admins only', async () => {
    await raw.db.insert(user).values({ id: 'u_thr', name: 'Thr', email: 'thr@example.com' });
    const actor = { orgId: 'org_a', userId: 'u_thr', roles: ['owner'] };
    const small = { format: 'json' as const, from: new Date('2026-09-20T00:00:00Z') };
    const denied = await openAuditExport(app.db, { ...actor, roles: ['viewer'] }, small);
    expect(denied).toEqual({ ok: false, code: 'forbidden_role' });
    const first = await openAuditExport(app.db, actor, small);
    expect(first.ok).toBe(true);
    expect(await openAuditExport(app.db, actor, small)).toEqual({
      ok: false,
      code: 'export_in_progress',
    });
    if (first.ok) await first.finish();
    for (let i = 1; i < EXPORTS_PER_HOUR; i++) {
      const next = await openAuditExport(app.db, actor, small);
      expect(next.ok).toBe(true);
      if (next.ok) await next.finish();
    }
    expect(await openAuditExport(app.db, actor, small)).toEqual({
      ok: false,
      code: 'export_rate_limited',
    });
  });
});
