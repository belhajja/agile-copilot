import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { account, createDb, user } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBreakGlassAccount } from './break-glass';
import { createAuthHolder, SSO_DISCOVERY_TIMEOUT_MS, SSO_RETRY_MS } from './holder';
import { type AuthOptions, createAuth } from './server';
import type { SsoConfig } from './sso';
import { type MockOidc, ssoRoundTrip, startMockOidc } from './testing/mock-oidc';

const BASE = 'http://localhost:3000';
const cookieHeader = (h: Headers) =>
  new Headers({
    cookie: h
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
const jarHeaders = (jar: Map<string, string>) =>
  new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
const jarOf = (headers: Headers) =>
  new Map(
    cookieHeader(headers)
      .get('cookie')
      ?.split('; ')
      .map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as [string, string]),
  );

/** An issuer that accepts TCP connections and never answers (a hung or blackholed IdP). */
async function startBlackhole(): Promise<{ issuer: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    issuer: `http://127.0.0.1:${port}/realms/acme`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** An issuer whose discovery document is whatever `doc` returns (status 200 unless it is a number). */
async function startFakeDiscovery(doc: (issuer: string) => Record<string, unknown> | number) {
  const server = createHttpServer((_req, res) => {
    const body = doc(issuer);
    res.writeHead(typeof body === 'number' ? body : 200, { 'content-type': 'application/json' });
    res.end(typeof body === 'number' ? '{}' : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/realms/acme`;
  return { issuer, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A browser request to the auth handler (with the Origin header a browser sends). */
const httpPost = (
  auth: { handler(r: Request): Promise<Response> },
  path: string,
  body: unknown,
  cookie = '',
) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie },
      body: JSON.stringify(body),
    }),
  );

/** Runs the break-glass CLI as an operator would, the password on stdin. */
function runBreakGlassCli(
  args: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; out: string }> {
  const pkg = join(import.meta.dirname, '..');
  // tsx's CLI run by this node: node_modules/.bin/tsx is a .cmd shim on Windows, which spawn
  // cannot start without a shell.
  const tsxCli = createRequire(join(pkg, 'package.json')).resolve('tsx/cli');
  const child = spawn(process.execPath, [tsxCli, 'src/break-glass-cli.ts', ...args], {
    cwd: pkg,
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

const elapsed = async <T>(fn: () => Promise<T>) => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
};

describe('SSO (OIDC) and the password policy', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let idp: MockOidc;
  let sso: SsoConfig;
  let options: AuthOptions;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 4 });
    idp = await startMockOidc();
    sso = { provider: 'keycloak', issuer: idp.issuer, clientId: 'agile', clientSecret: 's3cret' };
    options = {
      db: conn.db,
      secret: 'x'.repeat(32),
      baseURL: BASE,
      sso,
      breakGlassEmails: ['root@example.com'],
    };
  });
  afterAll(async () => {
    await idp?.close();
    await conn?.close();
    await tdb?.stop();
  });

  const accountsOf = async (email: string) => {
    const rows = await conn.db
      .select({ providerId: account.providerId })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, email));
    return rows.map((r) => r.providerId).sort();
  };
  const userRow = async (email: string) =>
    (await conn.db.select().from(user).where(eq(user.email, email)))[0];

  it('creates the account on first SSO sign-in, with the IdP-verified address', async () => {
    const auth = createAuth(options);
    idp.setUser({ sub: 'kc-1', email: 'Alice@Example.com', name: 'Alice', emailVerified: true });
    const { location, cookies } = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect(location).toBe('/');
    const session = await auth.api.getSession({ headers: jarHeaders(cookies) });
    expect(session?.user).toMatchObject({ email: 'alice@example.com', emailVerified: true });
    // No workspace yet: the user lands on onboarding (invitations or a new workspace).
    expect(session?.session.activeOrganizationId ?? null).toBeNull();
    expect(await accountsOf('alice@example.com')).toEqual(['keycloak']);
    // OAuth tokens are stored encrypted (the mock IdP's access tokens are JWTs: eyJ…).
    const [stored] = await conn.db
      .select({ accessToken: account.accessToken })
      .from(account)
      .where(eq(account.userId, session?.user.id ?? ''));
    expect(stored?.accessToken).toBeTruthy();
    expect(stored?.accessToken).not.toMatch(/^eyJ/);
    expect(stored?.accessToken).toMatch(/^[0-9a-f]+$/);
    // Signing in again finds the same account.
    const again = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect((await auth.api.getSession({ headers: jarHeaders(again.cookies) }))?.user.id).toBe(
      session?.user.id,
    );
  });

  it('keeps the IdP saying "unverified" on a first SSO sign-in', async () => {
    const auth = createAuth(options);
    idp.setUser({ sub: 'kc-dan', email: 'dan@example.com', name: 'Dan', emailVerified: false });
    const { cookies } = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    const session = await auth.api.getSession({ headers: jarHeaders(cookies) });
    expect(session?.user).toMatchObject({ email: 'dan@example.com', emailVerified: false });
  });

  it('never attaches an SSO identity to an existing password account by itself', async () => {
    const auth = createAuth(options);
    // Someone registered the victim's address with a password first (no verification).
    await auth.api.signUpEmail({
      body: { email: 'victim@example.com', password: 'attacker-pass-1', name: 'Squatter' },
    });
    idp.setUser({ sub: 'kc-victim', email: 'victim@example.com', name: 'V', emailVerified: true });
    const { location, cookies } = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect(location).toContain('error=account_not_linked');
    expect(await auth.api.getSession({ headers: jarHeaders(cookies) })).toBeNull();
    expect(await accountsOf('victim@example.com')).toEqual(['credential']);
    expect((await userRow('victim@example.com'))?.emailVerified).toBe(false);
  });

  it('links SSO to a password account when its owner does it while signed in', async () => {
    const auth = createAuth(options);
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'bob@example.com', password: 'bob-password-1', name: 'Bob' },
      returnHeaders: true,
    });
    const signedIn = jarOf(headers);
    idp.setUser({ sub: 'kc-bob', email: 'bob@example.com', name: 'Bob', emailVerified: true });
    await ssoRoundTrip(auth, {
      baseURL: BASE,
      provider: 'keycloak',
      cookies: signedIn,
      link: true,
    });
    expect(await accountsOf('bob@example.com')).toEqual(['credential', 'keycloak']);
    // The IdP vouched for this very address, so it now counts as verified (M6).
    expect((await userRow('bob@example.com'))?.emailVerified).toBe(true);

    // From now on SSO signs Bob in to his own account.
    const sso2 = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect((await auth.api.getSession({ headers: jarHeaders(sso2.cookies) }))?.user.email).toBe(
      'bob@example.com',
    );
  });

  it('refuses to link an identity whose address the IdP did not verify', async () => {
    const auth = createAuth(options);
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'carol@example.com', password: 'carol-password-1', name: 'Carol' },
      returnHeaders: true,
    });
    idp.setUser({ sub: 'kc-carol', email: 'carol@example.com', name: 'C', emailVerified: false });
    const linked = await ssoRoundTrip(auth, {
      baseURL: BASE,
      provider: 'keycloak',
      cookies: jarOf(headers),
      link: true,
    });
    expect(linked.location).toContain('error=');
    expect(await accountsOf('carol@example.com')).toEqual(['credential']);
    expect((await userRow('carol@example.com'))?.emailVerified).toBe(false);
  });

  it('refuses to link an identity with a different address', async () => {
    const auth = createAuth(options);
    const { headers } = await auth.api.signInEmail({
      body: { email: 'carol@example.com', password: 'carol-password-1' },
      returnHeaders: true,
    });
    idp.setUser({
      sub: 'kc-mallory',
      email: 'mallory@example.com',
      name: 'M',
      emailVerified: true,
    });
    const linked = await ssoRoundTrip(auth, {
      baseURL: BASE,
      provider: 'keycloak',
      cookies: jarOf(headers),
      link: true,
    });
    expect(linked.location).toContain('error=');
    expect(await accountsOf('carol@example.com')).toEqual(['credential']);
    expect(await userRow('mallory@example.com')).toBeUndefined();
  });

  it('with SSO, accepting an invitation needs an IdP-verified address (link, then accept)', async () => {
    const auth = createAuth(options);
    const owner = await auth.api.signInEmail({
      body: { email: 'bob@example.com', password: 'bob-password-1' },
      returnHeaders: true,
    });
    const org = await auth.api.createOrganization({
      headers: cookieHeader(owner.headers),
      body: { name: 'Acme', slug: 'acme' },
    });
    const organizationId = org?.id ?? '';
    const invite = (email: string) =>
      auth.api.createInvitation({
        headers: cookieHeader(owner.headers),
        body: { email, role: 'viewer' as 'admin', organizationId },
      });

    // Carol's address is not verified (password sign-up, IdP said unverified): refused.
    const forCarol = await invite('carol@example.com');
    const carol = await auth.api.signInEmail({
      body: { email: 'carol@example.com', password: 'carol-password-1' },
      returnHeaders: true,
    });
    await expect(
      auth.api.acceptInvitation({
        headers: cookieHeader(carol.headers),
        body: { invitationId: forCarol?.id ?? '' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Erin signs up with a password, links her verified SSO identity, then accepts.
    const erin = await auth.api.signUpEmail({
      body: { email: 'erin@example.com', password: 'erin-password-1', name: 'Erin' },
      returnHeaders: true,
    });
    const forErin = await invite('erin@example.com');
    idp.setUser({ sub: 'kc-erin', email: 'erin@example.com', name: 'Erin', emailVerified: true });
    await ssoRoundTrip(auth, {
      baseURL: BASE,
      provider: 'keycloak',
      cookies: jarOf(erin.headers),
      link: true,
    });
    const accepted = await auth.api.acceptInvitation({
      headers: cookieHeader(erin.headers),
      body: { invitationId: forErin?.id ?? '' },
    });
    expect(accepted?.member).toMatchObject({ organizationId, role: 'viewer' });
  });

  it('creates a break-glass account only through createBreakGlassAccount, never a bare server-side sign-up (A-m2)', async () => {
    const auth = createAuth({ ...options, breakGlassEmails: ['ops3@example.com'] });
    // An in-process call without the CLI's marker (a future server action, say) is refused like
    // an HTTP sign-up: no request is not proof of the operator.
    await expect(
      auth.api.signUpEmail({
        body: { email: 'ops3@example.com', password: 'break-glass-pass', name: 'Ops' },
      }),
    ).rejects.toMatchObject({ body: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' } });
    const strict = createAuth({
      ...options,
      passwordLogin: 'admin_only',
      breakGlassEmails: ['ops3@example.com'],
    });
    await expect(
      strict.api.signUpEmail({
        body: { email: 'ops3@example.com', password: 'break-glass-pass', name: 'Ops' },
      }),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: 'SIGN_UP_NOT_ALLOWED' } });
    expect(await userRow('ops3@example.com')).toBeUndefined();
    await createBreakGlassAccount(strict, ['ops3@example.com'], {
      email: 'ops3@example.com',
      password: 'break-glass-pass',
      name: 'Ops',
    });
    expect(await userRow('ops3@example.com')).toBeDefined();
  });

  it('with PASSWORD_LOGIN=admin_only, passwords work for break-glass accounts only', async () => {
    const auth = createAuth({ ...options, passwordLogin: 'admin_only' });
    // Nobody creates a break-glass account over HTTP, whatever the mode.
    const anonymous = await httpPost(auth, '/sign-up/email', {
      email: 'Root@Example.com',
      password: 'break-glass-pass',
      name: 'Root',
    });
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ code: 'SIGN_UP_NOT_ALLOWED' });
    expect(await userRow('root@example.com')).toBeUndefined();
    // Bootstrap: an operator creates it server-side (the CLI; any letter case).
    await createBreakGlassAccount(auth, ['root@example.com'], {
      email: 'Root@Example.com',
      password: 'break-glass-pass',
      name: 'Root',
    });
    await expect(
      auth.api.signUpEmail({
        body: { email: 'new@example.com', password: 'new-password-1', name: 'New' },
      }),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: 'SIGN_UP_NOT_ALLOWED' } });
    // bob@example.com has a password (set before the switch) but is not a platform admin: his
    // right password reads exactly like a wrong one (P5-R39).
    await expect(
      auth.api.signInEmail({ body: { email: 'bob@example.com', password: 'bob-password-1' } }),
    ).rejects.toMatchObject({ statusCode: 401, body: { code: 'INVALID_EMAIL_OR_PASSWORD' } });
    const root = await auth.api.signInEmail({
      body: { email: 'root@example.com', password: 'break-glass-pass' },
    });
    expect(root.user.email).toBe('root@example.com');
    // SSO keeps working for everyone else.
    idp.setUser({ sub: 'kc-bob', email: 'bob@example.com', name: 'Bob', emailVerified: true });
    const viaSso = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect((await auth.api.getSession({ headers: jarHeaders(viaSso.cookies) }))?.user.email).toBe(
      'bob@example.com',
    );
    // Nor can Bob drop his SSO identity: that sign-in is the only one left to him.
    const [bobSso] = await conn.db
      .select({ id: account.id })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, 'bob@example.com'));
    const unlink = await httpPost(
      auth,
      '/unlink-account',
      { accountId: bobSso?.id ?? '' },
      jarHeaders(viaSso.cookies).get('cookie') ?? '',
    );
    expect(unlink.status).toBe(403);
    expect(await unlink.json()).toMatchObject({ code: 'SSO_UNLINK_NOT_ALLOWED' });
    expect(await accountsOf('bob@example.com')).toContain('keycloak');
  });

  it('never tells who is a platform administrator (P5-R39): identical refusals', async () => {
    const auth = createAuth({ ...options, passwordLogin: 'admin_only' });
    const answer = async (path: string, body: Record<string, string>) => {
      const res = await httpPost(auth, path, body);
      return { status: res.status, body: await res.json() };
    };
    // Sign-in: a non-admin's right password, an unknown address, an admin's wrong password.
    const signIns = [
      await answer('/sign-in/email', { email: 'bob@example.com', password: 'bob-password-1' }),
      await answer('/sign-in/email', { email: 'nobody@example.com', password: 'whatever-pass-1' }),
      await answer('/sign-in/email', { email: 'root@example.com', password: 'wrong-password-1' }),
    ];
    expect(signIns[0]).toEqual({
      status: 401,
      body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
    });
    expect(signIns[1]).toEqual(signIns[0]);
    expect(signIns[2]).toEqual(signIns[0]);
    // Sign-up: an admin address and any other address get the same refusal.
    const signUp = (email: string) =>
      answer('/sign-up/email', { email, password: 'p-password-12', name: 'P' });
    const signUps = [
      await signUp('root@example.com'),
      await signUp('zed@example.com'),
      await signUp('bob@example.com'),
    ];
    expect(signUps[0]?.status).toBe(403);
    expect(signUps[1]).toEqual(signUps[0]);
    expect(signUps[2]).toEqual(signUps[0]);
  });

  it('spends a password hash on a refused non-admin sign-in, like on an unknown address', async () => {
    const auth = createAuth({ ...options, passwordLogin: 'admin_only' });
    const { password } = await auth.$context;
    const hash = vi.spyOn(password, 'hash');
    const verify = vi.spyOn(password, 'verify');
    try {
      for (const email of ['nobody@example.com', 'bob@example.com']) {
        hash.mockClear();
        verify.mockClear();
        const res = await httpPost(auth, '/sign-in/email', { email, password: 'bob-password-1' });
        expect(res.status).toBe(401);
        // Timing: the refusal costs one hash, as for any address without a password account.
        expect(hash).toHaveBeenCalledTimes(1);
        expect(verify).not.toHaveBeenCalled();
      }
    } finally {
      hash.mockRestore();
      verify.mockRestore();
    }
  });

  it('never attaches an SSO identity to a break-glass account', async () => {
    const auth = createAuth({ ...options, passwordLogin: 'admin_only' });
    const { headers } = await auth.api.signInEmail({
      body: { email: 'root@example.com', password: 'break-glass-pass' },
      returnHeaders: true,
    });
    idp.setUser({ sub: 'kc-root', email: 'root@example.com', name: 'Root', emailVerified: true });
    const linked = await ssoRoundTrip(auth, {
      baseURL: BASE,
      provider: 'keycloak',
      cookies: jarOf(headers),
      link: true,
    });
    expect(linked.location).toContain('error=');
    expect(await accountsOf('root@example.com')).toEqual(['credential']);
    expect((await userRow('root@example.com'))?.emailVerified).toBe(false);
    // Nor by itself, signed out (the record is unverified anyway; the hook is the second layer).
    const signedOut = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect(signedOut.location).toContain('error=');
    expect(await accountsOf('root@example.com')).toEqual(['credential']);
  });

  it('never creates a user for a break-glass address through SSO', async () => {
    const auth = createAuth({ ...options, breakGlassEmails: ['ops@example.com'] });
    idp.setUser({ sub: 'kc-ops', email: 'Ops@Example.com', name: 'Ops', emailVerified: true });
    const { location, cookies } = await ssoRoundTrip(auth, { baseURL: BASE, provider: 'keycloak' });
    expect(location).toContain('error=');
    expect(await auth.api.getSession({ headers: jarHeaders(cookies) })).toBeNull();
    expect(await userRow('ops@example.com')).toBeUndefined();
    // The operator can still create it with a password, server-side.
    await createBreakGlassAccount(auth, ['ops@example.com'], {
      email: 'ops@example.com',
      password: 'break-glass-pass',
      name: 'Ops',
    });
    expect(await accountsOf('ops@example.com')).toEqual(['credential']);
  });

  it('turns SSO on once the IdP answers, without a restart', async () => {
    const down = await startMockOidc();
    const issuer = down.issuer;
    const port = Number(new URL(issuer).port);
    await down.close();
    let now = 0;
    const holder = createAuthHolder({ ...options, sso: { ...sso, issuer } }, { now: () => now });
    expect(await holder.ssoReady()).toBe(false);
    // Password sign-in keeps working meanwhile (break-glass).
    expect(
      (
        await holder
          .get()
          .api.signInEmail({ body: { email: 'bob@example.com', password: 'bob-password-1' } })
      ).user.email,
    ).toBe('bob@example.com');

    const up = await startMockOidc({ port });
    try {
      expect(await holder.ssoReady()).toBe(false); // within the retry window
      now += SSO_RETRY_MS;
      expect(await holder.ssoReady()).toBe(true);
      up.setUser({ sub: 'kc-1', email: 'alice@example.com', name: 'Alice', emailVerified: true });
      const { cookies } = await ssoRoundTrip(holder.get(), { baseURL: BASE, provider: 'keycloak' });
      expect(
        (await holder.get().api.getSession({ headers: jarHeaders(cookies) }))?.user.email,
      ).toBe('alice@example.com');
    } finally {
      await up.close();
    }
  });

  it('never makes password or session requests wait for an IdP that does not answer', async () => {
    // A request that waited for discovery would take its whole timeout (4 s). The bound sits well
    // below that and far above a scrypt sign-in on a loaded machine (containers starting beside
    // it), so it tells the two apart without timing a password hash to the millisecond.
    const NO_WAIT_MS = SSO_DISCOVERY_TIMEOUT_MS - 1_000;
    const hole = await startBlackhole();
    try {
      const holder = createAuthHolder({
        ...options,
        sso: { ...sso, issuer: hole.issuer },
        passwordLogin: 'admin_only',
      });
      const signIn = await elapsed(() =>
        holder.get().api.signInEmail({
          body: { email: 'root@example.com', password: 'break-glass-pass' },
          returnHeaders: true,
        }),
      );
      expect(signIn.value.response.user.email).toBe('root@example.com');
      expect(signIn.ms).toBeLessThan(NO_WAIT_MS);
      const session = await elapsed(() =>
        holder.get().api.getSession({ headers: cookieHeader(signIn.value.headers) }),
      );
      expect(session.value?.user.email).toBe('root@example.com');
      expect(session.ms).toBeLessThan(NO_WAIT_MS);
      // Non-break-glass passwords are still refused right away, not after a discovery timeout.
      const refused = await elapsed(() =>
        holder
          .get()
          .api.signInEmail({ body: { email: 'bob@example.com', password: 'bob-password-1' } })
          .catch((e: unknown) => e),
      );
      expect(refused.value).toMatchObject({ body: { code: 'INVALID_EMAIL_OR_PASSWORD' } });
      expect(refused.ms).toBeLessThan(NO_WAIT_MS);
      // Discovery gives up after its timeout; SSO stays off.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ready = await elapsed(() => holder.ssoReady());
      expect(ready.value).toBe(false);
      expect(ready.ms).toBeLessThan(SSO_DISCOVERY_TIMEOUT_MS + 1_000);
      expect(warn).toHaveBeenCalledWith('[auth] sso_discovery_timeout TimeoutError');
      warn.mockRestore();
    } finally {
      await hole.close();
    }
  }, 15_000);

  it('refuses ID-token sign-in and linking (the redirect flow with PKCE and nonce only)', async () => {
    const auth = createAuth(options);
    idp.setUser({ sub: 'kc-ivan', email: 'ivan@example.com', name: 'Ivan', emailVerified: true });
    // A genuine token from our IdP, for our client, without a nonce.
    const token = await idp.signIdToken('agile');
    const signIn = await httpPost(auth, '/sign-in/social', {
      provider: 'keycloak',
      idToken: { token },
    });
    expect(signIn.status).toBe(400);
    expect(await signIn.json()).toMatchObject({ code: 'ID_TOKEN_SIGN_IN_DISABLED' });
    expect(signIn.headers.getSetCookie().some((c) => c.includes('session_token'))).toBe(false);
    expect(await userRow('ivan@example.com')).toBeUndefined();

    const { headers } = await auth.api.signInEmail({
      body: { email: 'carol@example.com', password: 'carol-password-1' },
      returnHeaders: true,
    });
    const cookie = cookieHeader(headers).get('cookie') ?? '';
    const link = await httpPost(
      auth,
      '/link-social',
      { provider: 'keycloak', idToken: { token } },
      cookie,
    );
    expect(link.status).toBe(400);
    expect(await link.json()).toMatchObject({ code: 'ID_TOKEN_SIGN_IN_DISABLED' });
    expect(await accountsOf('carol@example.com')).toEqual(['credential']);
  });

  it('refuses scopes chosen by the browser', async () => {
    const auth = createAuth(options);
    const start = await httpPost(auth, '/sign-in/social', {
      provider: 'keycloak',
      callbackURL: '/',
      scopes: ['offline_access'],
    });
    expect(start.status).toBe(400);
    expect(await start.json()).toMatchObject({ code: 'SCOPES_NOT_ALLOWED' });
    const { headers } = await auth.api.signInEmail({
      body: { email: 'carol@example.com', password: 'carol-password-1' },
      returnHeaders: true,
    });
    const link = await httpPost(
      auth,
      '/link-social',
      { provider: 'keycloak', callbackURL: '/', scopes: ['offline_access'] },
      cookieHeader(headers).get('cookie') ?? '',
    );
    expect(link.status).toBe(400);
    expect(await link.json()).toMatchObject({ code: 'SCOPES_NOT_ALLOWED' });
  });

  it('only lets SSO return to our own origin', async () => {
    const auth = createAuth(options);
    await expect(
      ssoRoundTrip(auth, {
        baseURL: BASE,
        provider: 'keycloak',
        callbackURL: 'https://evil.example/after-login',
      }),
    ).rejects.toThrow(/SSO start failed \(403\)/);
  });

  it('refuses HTTP sign-up for a break-glass address in every mode; the server side may', async () => {
    const auth = createAuth({ ...options, breakGlassEmails: ['ops2@example.com'] });
    const res = await httpPost(auth, '/sign-up/email', {
      email: 'OPS2@Example.com',
      password: 'break-glass-pass',
      name: 'Ops',
    });
    expect(await userRow('ops2@example.com')).toBeUndefined();
    // Ordinary sign-ups are untouched in `all` mode.
    const frank = { email: 'frank@example.com', password: 'frank-password-1', name: 'Frank' };
    expect((await httpPost(auth, '/sign-up/email', frank)).status).toBe(200);
    // The refusal reads like any taken address (P5-R39): nothing says "platform administrator".
    const taken = await httpPost(auth, '/sign-up/email', frank);
    expect(taken.status).toBe(422);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: taken.status,
      body: await taken.json(),
    });
    // The server-side helper refuses addresses that are not break-glass.
    await expect(
      createBreakGlassAccount(auth, ['ops2@example.com'], {
        email: 'grace@example.com',
        password: 'grace-password-1',
        name: 'Grace',
      }),
    ).rejects.toThrow('NOT_BREAK_GLASS');
    expect(await userRow('grace@example.com')).toBeUndefined();
  });

  it('creates a break-glass account from the CLI, the password read from stdin', async () => {
    const env = {
      DATABASE_URL: tdb.appUrl,
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: BASE,
      ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 1).toString('base64')}`,
      BREAK_GLASS_EMAILS: 'cli@example.com',
    };
    const refused = await runBreakGlassCli(['nope@example.com'], env, 'cli-password-12\n');
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('NOT_BREAK_GLASS');
    expect(await userRow('nope@example.com')).toBeUndefined();

    // As Windows PowerShell pipes it: a byte order mark and CRLF.
    const ok = await runBreakGlassCli(['cli@example.com'], env, '﻿cli-password-12\r\n');
    expect(ok.out).not.toContain('cli-password-12');
    expect(ok.code).toBe(0);
    const auth = createAuth({ ...options, breakGlassEmails: ['cli@example.com'] });
    const signedIn = await auth.api.signInEmail({
      body: { email: 'cli@example.com', password: 'cli-password-12' },
    });
    expect(signedIn.user.email).toBe('cli@example.com');
  }, 30_000);

  it('logs why discovery failed, with a distinct code and no details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [
      { code: 'sso_issuer_mismatch', doc: () => ({ issuer: 'https://evil.example' }) },
      { code: 'sso_discovery_http', doc: () => 503 },
      { code: 'sso_discovery_incomplete', doc: (issuer: string) => ({ issuer }) },
    ];
    try {
      for (const c of cases) {
        const fake = await startFakeDiscovery(c.doc);
        try {
          const holder = createAuthHolder({ ...options, sso: { ...sso, issuer: fake.issuer } });
          expect(await holder.ssoReady()).toBe(false);
          expect(warn).toHaveBeenLastCalledWith(
            expect.stringMatching(new RegExp(`^\\[auth\\] ${c.code} `)),
          );
        } finally {
          await fake.close();
        }
      }
      for (const [line] of warn.mock.calls) expect(String(line)).not.toContain('127.0.0.1');
    } finally {
      warn.mockRestore();
    }
  });
});
