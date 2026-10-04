import { createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
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

  it('returns no roles for a non-member', async () => {
    expect(await getMemberRoles(conn.db, 'org_missing', 'user_missing')).toEqual([]);
    expect(canManageConnections(['member'])).toBe(false);
  });
});
