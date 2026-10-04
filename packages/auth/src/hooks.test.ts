import * as db from '@agile/db';
import { auditLog, createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Auth, createAuth } from './server';

vi.mock('@agile/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agile/db')>();
  return { ...actual, recordAudit: vi.fn(actual.recordAudit) };
});

const cookieHeader = (h: Headers) =>
  new Headers({
    cookie: h
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

describe('a failing audit write never fails a membership change (P5-R30)', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  let auth: Auth;
  let orgId = '';
  let ownerH: Headers;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    auth = createAuth({ db: conn.db, secret: 'x'.repeat(32), baseURL: 'http://localhost:3000' });
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'correct-horse-1', name: 'o' },
      returnHeaders: true,
    });
    ownerH = cookieHeader(headers);
    orgId = (await auth.api.createOrganization({ headers: ownerH, body: { name: 'A', slug: 'a' } }))
      ?.id as string;
  });
  afterEach(() => {
    vi.mocked(db.recordAudit).mockClear();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await conn?.close();
    await raw?.close();
    await tdb?.stop();
  });

  const invite = (email: string) =>
    auth.api.createInvitation({
      headers: ownerH,
      body: { email, role: 'viewer' as 'admin', organizationId: orgId },
    });
  const rows = () => raw.db.select().from(auditLog).where(eq(auditLog.orgId, orgId));

  it('retries once, so one transient failure still leaves the row', async () => {
    vi.mocked(db.recordAudit).mockRejectedValueOnce(new Error('transient'));
    const inv = await invite('one@example.com');
    expect(inv?.id).toBeTruthy();
    expect((await rows()).map((r) => r.targetId)).toContain(inv?.id);
  });

  it('answers normally and logs the code and error name when the audit keeps failing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('secret detail user@example.com'), { name: 'PgError' });
    vi.mocked(db.recordAudit).mockRejectedValue(failure);
    const inv = await invite('two@example.com');
    expect(inv?.id).toBeTruthy();
    expect(db.recordAudit).toHaveBeenCalledTimes(2);
    expect((await rows()).map((r) => r.targetId)).not.toContain(inv?.id);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toBe('[auth] member_audit_failed PgError member.invited');
    expect(line).not.toContain('secret');
    // The change itself stood.
    const pending = await auth.api.listInvitations({
      headers: ownerH,
      query: { organizationId: orgId },
    });
    expect(pending.map((i) => i.email)).toContain('two@example.com');
  });
});
