import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, createDb, user } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthHolder, createAuthHolder } from './holder';
import { KEYCLOAK_IMAGE } from './testing/keycloak';

// The development realm (docker/keycloak/agile-realm.json): client `agile-copilot` and two users,
// alice (verified address) and eve (unverified).
const REALM = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docker', 'keycloak', 'agile-realm.json'),
  'utf8',
);
const BASE = 'http://localhost:3000';

type Jar = Map<string, string>;
const store = (res: Response, jar: Jar) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair = ''] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const header = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const decode = (s: string) => s.replaceAll('&amp;', '&');

/**
 * A browser signing in through Keycloak's real login page: our start endpoint → Keycloak's form →
 * username and password → our callback. Returns where the app finally redirects, and its cookies.
 */
async function signInThroughKeycloak(holder: AuthHolder, username: string, password: string) {
  const auth = holder.get();
  const app: Jar = new Map();
  const idp: Jar = new Map();
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'keycloak', callbackURL: '/' }),
    }),
  );
  store(start, app);
  const { url } = (await start.json()) as { url: string };
  const page = await fetch(url, { redirect: 'manual' });
  store(page, idp);
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error(`no Keycloak login form (${page.status})`);
  const posted = await fetch(decode(action), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: header(idp) },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  const callback = posted.headers.get('location');
  if (!callback?.startsWith(`${BASE}/api/auth/callback/keycloak`)) {
    throw new Error(`Keycloak did not redirect back (${posted.status})`);
  }
  const done = await auth.handler(new Request(callback, { headers: { cookie: header(app) } }));
  store(done, app);
  return { location: done.headers.get('location') ?? '', cookies: app };
}

describe('Keycloak contract (real IdP, better-auth genericOAuth keycloak())', () => {
  let keycloak: StartedTestContainer;
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let holder: AuthHolder;

  beforeAll(async () => {
    [keycloak, tdb] = await Promise.all([
      new GenericContainer(KEYCLOAK_IMAGE)
        .withEnvironment({
          KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
          KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
          KC_HEALTH_ENABLED: 'true',
        })
        .withCopyContentToContainer([
          { content: REALM, target: '/opt/keycloak/data/import/agile-realm.json' },
        ])
        .withCommand(['start-dev', '--import-realm'])
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/realms/agile/.well-known/openid-configuration', 8080))
        .withStartupTimeout(240_000)
        .start(),
      startTestDatabase(),
    ]);
    conn = createDb(tdb.appUrl, { max: 2 });
    const issuer = `http://${keycloak.getHost()}:${keycloak.getMappedPort(8080)}/realms/agile`;
    // Production builds auth through the holder (discovery with a timeout, then the swap).
    holder = createAuthHolder({
      db: conn.db,
      secret: 'x'.repeat(32),
      baseURL: BASE,
      sso: {
        provider: 'keycloak',
        issuer,
        clientId: 'agile-copilot',
        clientSecret: 'dev-only-client-secret',
      },
    });
    // Waits for the holder's background discovery and the swap to the SSO instance.
    expect(await holder.ssoReady()).toBe(true);
  }, 300_000);
  afterAll(async () => {
    await conn?.close();
    await tdb?.stop();
    await keycloak?.stop();
  });

  it('discovers Keycloak and signs a verified user in (PKCE, nonce, signed ID token)', async () => {
    expect((await holder.get().$context).socialProviders.map((p) => p.id)).toContain('keycloak');
    const { location, cookies } = await signInThroughKeycloak(
      holder,
      'alice',
      'alice-dev-password',
    );
    expect(location).toBe('/');
    const session = await holder.get().api.getSession({
      headers: new Headers({ cookie: header(cookies) }),
    });
    expect(session?.user).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice Martin',
      emailVerified: true,
    });
    const [linked] = await conn.db
      .select({ providerId: account.providerId, accountId: account.accountId })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, 'alice@example.com'));
    // The account is keyed by Keycloak's stable subject, not the e-mail address.
    expect(linked?.providerId).toBe('keycloak');
    expect(linked?.accountId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps an unverified Keycloak address unverified', async () => {
    const { cookies } = await signInThroughKeycloak(holder, 'eve', 'eve-dev-password');
    const session = await holder.get().api.getSession({
      headers: new Headers({ cookie: header(cookies) }),
    });
    // Signed in, but cannot accept invitations (requireEmailVerificationOnInvitation with SSO).
    expect(session?.user).toMatchObject({ email: 'eve@example.com', emailVerified: false });
  });

  it('rejects a wrong password at Keycloak (nothing reaches the app)', async () => {
    await expect(signInThroughKeycloak(holder, 'alice', 'wrong-password')).rejects.toThrow(
      /did not redirect back/,
    );
  });
});
