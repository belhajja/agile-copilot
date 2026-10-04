import { createDb, signInAttempts } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthOptions, createAuth } from './server';
import { ACCOUNT_SIGN_IN_ATTEMPTS } from './sign-in-limits';

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct-horse-1';
let lastOctet = 0;
/** A client address no other request in this file uses (a fresh per-address bucket). */
const freshAddress = () => {
  lastOctet += 1;
  return `198.51.${Math.floor(lastOctet / 250)}.${(lastOctet % 250) + 1}`;
};

/**
 * Sign-in limits (P5-R47). better-auth's per-address limiter is off under test by default; these
 * cases turn it on as it is in production. Its buckets live in module memory for the whole file,
 * so each case uses its own addresses (or none, for the shared bucket).
 */
describe('sign-in limits', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  const make = (options: Partial<AuthOptions> = {}) =>
    createAuth({ db: conn.db, secret: 'x'.repeat(32), baseURL: BASE, ...options });

  const signIn = (
    auth: ReturnType<typeof make>,
    email: string,
    password: string,
    headers: Record<string, string> = {},
  ) =>
    auth.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, ...headers },
        body: JSON.stringify({ email, password }),
      }),
    );
  const statusOf = async (r: Promise<Response>) => (await r).status;
  const count = (statuses: number[]) => {
    const counts: Record<number, number> = {};
    for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
    return counts;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 4 });
    const auth = make();
    for (const email of ['victim@example.com', 'bystander@example.com', 'reset@example.com']) {
      await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'n' } });
    }
  });
  afterAll(async () => {
    await conn?.close();
    await tdb?.stop();
  });

  describe('with no trusted proxy (TRUSTED_PROXY_HOPS=0)', () => {
    it('has no deployment-wide lockout at 3 per 10 s: everyone shares a generous ceiling', async () => {
      const auth = make({ rateLimit: { enabled: true } });
      const statuses = [];
      for (let i = 0; i < 6; i++)
        statuses.push(await statusOf(signIn(auth, 'nobody@example.com', 'wrong-password')));
      expect(count(statuses)).toEqual({ 401: 6 });
    });

    it('a client-written X-Forwarded-For never buys a fresh bucket', async () => {
      const auth = make({ rateLimit: { enabled: true, sharedPerMinute: 8 } });
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const xff = { 'x-forwarded-for': freshAddress() };
        statuses.push(await statusOf(signIn(auth, 'nobody2@example.com', 'wrong-password', xff)));
      }
      // 6 from the case above plus 2 here exhaust the shared ceiling of 8.
      expect(count(statuses)).toEqual({ 401: 2, 429: 2 });
      const spoofedHeader = { 'x-agile-client-address': freshAddress() };
      expect(await statusOf(signIn(auth, 'nobody2@example.com', 'x', spoofedHeader))).toBe(429);
    });
  });

  describe('behind one trusted proxy (TRUSTED_PROXY_HOPS=1)', () => {
    it('counts the entry our proxy wrote, whatever the client put before it', async () => {
      const auth = make({ trustedProxyHops: 1, rateLimit: { enabled: true } });
      const client = freshAddress();
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const xff = { 'x-forwarded-for': `${freshAddress()}, ${client}` };
        statuses.push(await statusOf(signIn(auth, 'nobody3@example.com', 'wrong-password', xff)));
      }
      // better-auth's sign-in rule: 3 per 10 s per address.
      expect(statuses).toEqual([401, 401, 401, 429]);
      // Nor can the client name its own address in the header the app sets.
      const forged = { 'x-forwarded-for': client, 'x-agile-client-address': freshAddress() };
      expect(await statusOf(signIn(auth, 'nobody3@example.com', 'wrong-password', forged))).toBe(
        429,
      );
      // Another client is not locked out.
      const other = { 'x-forwarded-for': `${client}, ${freshAddress()}` };
      expect(await statusOf(signIn(auth, 'nobody3@example.com', 'wrong-password', other))).toBe(
        401,
      );
    });
  });

  describe('per account, from any address', () => {
    const rotating = () => ({ 'x-forwarded-for': freshAddress() });

    it(`refuses the attempt after ${ACCOUNT_SIGN_IN_ATTEMPTS} for that address only`, async () => {
      const auth = make({ trustedProxyHops: 1, rateLimit: { enabled: true } });
      const statuses = [];
      for (let i = 0; i < ACCOUNT_SIGN_IN_ATTEMPTS; i++) {
        statuses.push(
          await statusOf(signIn(auth, 'victim@example.com', 'wrong-password', rotating())),
        );
      }
      expect(count(statuses)).toEqual({ 401: ACCOUNT_SIGN_IN_ATTEMPTS });

      // The next one is refused even with the right password, and the spelling does not matter.
      const refused = await signIn(auth, 'Victim@Example.COM', PASSWORD, rotating());
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('x-retry-after'))).toBeGreaterThan(0);
      expect(Number(refused.headers.get('x-retry-after'))).toBeLessThanOrEqual(15 * 60);
      // The same answer as better-auth's own limiter: a 429 with no code naming the account.
      expect(await refused.json()).toEqual({
        message: 'Too many requests. Please try again later.',
      });

      expect(await statusOf(signIn(auth, 'bystander@example.com', PASSWORD, rotating()))).toBe(200);
    });

    it('holds under parallel guesses (counted before the password is checked)', async () => {
      const auth = make();
      const statuses = await Promise.all(
        Array.from({ length: ACCOUNT_SIGN_IN_ATTEMPTS + 5 }, () =>
          statusOf(signIn(auth, 'parallel@example.com', 'wrong-password')),
        ),
      );
      expect(count(statuses)).toEqual({ 401: ACCOUNT_SIGN_IN_ATTEMPTS, 429: 5 });
    });

    it('a successful sign-in starts the count over', async () => {
      const auth = make();
      for (let i = 0; i < ACCOUNT_SIGN_IN_ATTEMPTS - 1; i++) {
        expect(await statusOf(signIn(auth, 'reset@example.com', 'wrong-password'))).toBe(401);
      }
      expect(await statusOf(signIn(auth, 'reset@example.com', PASSWORD))).toBe(200);
      for (let i = 0; i < ACCOUNT_SIGN_IN_ATTEMPTS; i++) {
        expect(await statusOf(signIn(auth, 'reset@example.com', 'wrong-password'))).toBe(401);
      }
      expect(await statusOf(signIn(auth, 'reset@example.com', 'wrong-password'))).toBe(429);
    });

    it('starts over once the window has passed, and forgets expired windows', async () => {
      const auth = make();
      const stale = sql`now() - interval '16 minutes'`;
      await conn.db.update(signInAttempts).set({ windowStartedAt: stale });
      await conn.db
        .insert(signInAttempts)
        .values({ keyHash: 'stale-key', attempts: 3, windowStartedAt: stale });
      expect(await statusOf(signIn(auth, 'victim@example.com', PASSWORD))).toBe(200);
      const keys = (await conn.db.select().from(signInAttempts)).map((r) => r.keyHash);
      expect(keys).not.toContain('stale-key');
    });

    it('stores a keyed hash, never the address', async () => {
      const make2 = make();
      await signIn(make2, 'hashed@example.com', 'wrong-password');
      const rows = await conn.db.select().from(signInAttempts);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.keyHash).not.toContain('example');
      }
    });
  });
});
