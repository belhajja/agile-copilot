import { auditLog, createDb, member as memberTable, orgDataKeys, withOrg } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canManageConnections, getMemberRoles } from './roles';
import { type Auth, createAuth } from './server';

const cookieHeader = (h: Headers) =>
  new Headers({
    cookie: h
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

describe('auth', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let auth: Auth;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 2 });
    auth = createAuth({ db: conn.db, secret: 'x'.repeat(32), baseURL: 'http://localhost:3000' });
  });
  afterAll(async () => {
    await conn?.close();
    await tdb?.stop();
  });

  it('signs up, creates a workspace, and the session carries it as active org', async () => {
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'pm@example.com', password: 'correct-horse-1', name: 'Pat' },
      returnHeaders: true,
    });
    const h = cookieHeader(headers);
    const org = await auth.api.createOrganization({
      headers: h,
      body: { name: 'Acme', slug: 'acme' },
    });
    const session = await auth.api.getSession({ headers: h });

    expect(org?.id).toBeTruthy();
    expect(session?.session.activeOrganizationId).toBe(org?.id);

    const roles = await getMemberRoles(conn.db, org?.id ?? '', session?.user.id ?? '');
    expect(roles).toEqual(['owner']);
    expect(canManageConnections(roles)).toBe(true);
  });

  it('signing back in reactivates the workspace the user already belongs to', async () => {
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'returning@example.com', password: 'correct-horse-1', name: 'Rae' },
      returnHeaders: true,
    });
    const org = await auth.api.createOrganization({
      headers: cookieHeader(headers),
      body: { name: 'Returning', slug: 'returning' },
    });

    const signIn = await auth.api.signInEmail({
      body: { email: 'returning@example.com', password: 'correct-horse-1' },
      returnHeaders: true,
    });
    const session = await auth.api.getSession({ headers: cookieHeader(signIn.headers) });

    expect(session?.session.activeOrganizationId).toBe(org?.id);
  });

  it('a user without any workspace signs in with no active org', async () => {
    await auth.api.signUpEmail({
      body: { email: 'loner@example.com', password: 'correct-horse-1', name: 'Lo' },
    });
    const signIn = await auth.api.signInEmail({
      body: { email: 'loner@example.com', password: 'correct-horse-1' },
      returnHeaders: true,
    });
    const session = await auth.api.getSession({ headers: cookieHeader(signIn.headers) });

    expect(session?.session.activeOrganizationId ?? null).toBeNull();
  });

  it('deleting a workspace purges its tenant rows but keeps the audit trail', async () => {
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'leaver@example.com', password: 'correct-horse-1', name: 'Lea' },
      returnHeaders: true,
    });
    const h = cookieHeader(headers);
    const doomed = await auth.api.createOrganization({
      headers: h,
      body: { name: 'Doomed', slug: 'doomed' },
    });
    const kept = await auth.api.createOrganization({
      headers: h,
      body: { name: 'Kept', slug: 'kept' },
    });
    const orgIds = [doomed?.id ?? '', kept?.id ?? ''];
    for (const orgId of orgIds) {
      await withOrg(conn.db, orgId, (tx) =>
        tx.insert(orgDataKeys).values({ orgId, kekVersion: 1, wrappedDek: 'wrapped' }),
      );
    }

    await auth.api.deleteOrganization({ headers: h, body: { organizationId: orgIds[0] ?? '' } });

    const owner = createDb(tdb.ownerUrl, { max: 1 });
    try {
      const keys = await owner.db.select({ orgId: orgDataKeys.orgId }).from(orgDataKeys);
      expect(keys.map((k) => k.orgId)).not.toContain(orgIds[0]);
      expect(keys.map((k) => k.orgId)).toContain(orgIds[1]);
      const audit = await owner.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.orgId, orgIds[0] ?? ''));
      expect(audit).toMatchObject([{ action: 'organization.deleted', targetId: orgIds[0] }]);
    } finally {
      await owner.close();
    }
  });

  it('invites with one of the four roles only; the invitee joins with that role', async () => {
    const signUp = async (email: string) =>
      cookieHeader(
        (
          await auth.api.signUpEmail({
            body: { email, password: 'correct-horse-1', name: email.split('@')[0] ?? 'x' },
            returnHeaders: true,
          })
        ).headers,
      );
    const ownerH = await signUp('boss@example.com');
    const org = await auth.api.createOrganization({
      headers: ownerH,
      body: { name: 'Roles', slug: 'roles' },
    });
    const organizationId = org?.id ?? '';

    // better-auth refuses unknown roles itself; its own `member` and lists are refused by our hook.
    await expect(
      auth.api.createInvitation({
        headers: ownerH,
        body: { email: 'new@example.com', role: 'superuser' as 'admin', organizationId },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const role of ['member', 'admin,manager']) {
      await expect(
        auth.api.createInvitation({
          headers: ownerH,
          body: { email: 'new@example.com', role: role as 'admin', organizationId },
        }),
      ).rejects.toMatchObject({ body: { code: 'ROLE_NOT_ALLOWED' } });
    }

    const invitation = await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'mgr@example.com', role: 'manager' as 'admin', organizationId },
    });
    const mgrH = await signUp('mgr@example.com');
    await auth.api.acceptInvitation({
      headers: mgrH,
      body: { invitationId: invitation?.id ?? '' },
    });
    const mgr = await auth.api.getSession({ headers: mgrH });
    expect(await getMemberRoles(conn.db, organizationId, mgr?.user.id ?? '')).toEqual(['manager']);

    // A manager manages nobody.
    await expect(
      auth.api.createInvitation({
        headers: mgrH,
        body: { email: 'x@example.com', role: 'viewer' as 'admin', organizationId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // The legacy role cannot come back through a role change either.
    const [mgrMember] = await conn.db
      .select()
      .from(memberTable)
      .where(eq(memberTable.userId, mgr?.user.id ?? ''));
    await expect(
      auth.api.updateMemberRole({
        headers: ownerH,
        body: { memberId: mgrMember?.id ?? '', role: 'member' as 'admin', organizationId },
      }),
    ).rejects.toMatchObject({ body: { code: 'ROLE_NOT_ALLOWED' } });
  });

  it('returns no roles for a non-member', async () => {
    expect(await getMemberRoles(conn.db, 'org_missing', 'user_missing')).toEqual([]);
    expect(canManageConnections(['member'])).toBe(false);
  });
});
