import { createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Auth, createAuth } from './server';

const PASSWORD = 'correct-horse-1';

const cookieHeader = (h: Headers) =>
  new Headers({
    cookie: h
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

describe('SIGNUP=invite', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let auth: Auth;

  const signUp = async (a: Auth, email: string) =>
    cookieHeader(
      (
        await a.api.signUpEmail({
          body: { email, password: PASSWORD, name: email.split('@')[0] ?? 'x' },
          returnHeaders: true,
        })
      ).headers,
    );
  const refused = { statusCode: 403, body: { code: 'SIGN_UP_NOT_ALLOWED' } };
  const noWorkspace = {
    statusCode: 403,
    body: { code: 'YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION' },
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 2 });
    auth = createAuth({
      db: conn.db,
      secret: 'x'.repeat(32),
      baseURL: 'http://localhost:3000',
      signup: 'invite',
    });
  });
  afterAll(async () => {
    await conn?.close();
    await tdb?.stop();
  });

  it('lets the first account in, then only invited addresses', async () => {
    const ownerH = await signUp(auth, 'first@example.com');
    const org = await auth.api.createOrganization({
      headers: ownerH,
      body: { name: 'First', slug: 'first' },
    });
    const organizationId = org?.id ?? '';

    await expect(signUp(auth, 'stranger@example.com')).rejects.toMatchObject(refused);

    await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'Invited@Example.com', role: 'viewer' as 'admin', organizationId },
    });
    const invitedH = await signUp(auth, 'invited@example.com');
    expect((await auth.api.getSession({ headers: invitedH }))?.user.email).toBe(
      'invited@example.com',
    );

    // A cancelled invitation no longer opens sign-up.
    const cancelled = await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'cancelled@example.com', role: 'viewer' as 'admin', organizationId },
    });
    await auth.api.cancelInvitation({
      headers: ownerH,
      body: { invitationId: cancelled?.id ?? '' },
    });
    await expect(signUp(auth, 'cancelled@example.com')).rejects.toMatchObject(refused);

    // Over HTTP: the same refusal.
    const res = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'web@example.com', password: PASSWORD, name: 'Web' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'SIGN_UP_NOT_ALLOWED' });
  });

  it('lets owners create workspaces, not members who joined by invitation', async () => {
    const ownerH = cookieHeader(
      (
        await auth.api.signInEmail({
          body: { email: 'first@example.com', password: PASSWORD },
          returnHeaders: true,
        })
      ).headers,
    );
    const invitedH = cookieHeader(
      (
        await auth.api.signInEmail({
          body: { email: 'invited@example.com', password: PASSWORD },
          returnHeaders: true,
        })
      ).headers,
    );
    await expect(
      auth.api.createOrganization({ headers: invitedH, body: { name: 'Mine', slug: 'mine' } }),
    ).rejects.toMatchObject(noWorkspace);
    const second = await auth.api.createOrganization({
      headers: ownerH,
      body: { name: 'Second', slug: 'second' },
    });
    expect(second?.id).toBeTruthy();
  });

  it('SIGNUP=open keeps self-service sign-up and workspaces', async () => {
    const open = createAuth({
      db: conn.db,
      secret: 'x'.repeat(32),
      baseURL: 'http://localhost:3000',
      signup: 'open',
    });
    const h = await signUp(open, 'self@example.com');
    const org = await open.api.createOrganization({
      headers: h,
      body: { name: 'Self', slug: 'self' },
    });
    expect(org?.id).toBeTruthy();
  });
});
