import { createHmac } from 'node:crypto';
import { type Db, signInAttempts } from '@agile/db';
import { clientAddress } from '@agile/net';
import { APIError } from 'better-auth/api';
import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { normalizeEmail } from './sso';

/**
 * Sign-in limits (P5-R47). Three layers:
 *
 * 1. Per client address: better-auth's own limiter (3 sign-ins per 10 s per address, 100 requests
 *    per 10 s on other paths; in memory, per process). It is fed the address from `clientAddress`
 *    (TRUSTED_PROXY_HOPS, the same rule as `/api/mcp`) through a header the app sets on every
 *    request, never X-Forwarded-For as the client sent it. Without a trusted address (the app
 *    reached directly) all requests share one bucket per path with a generous ceiling, so no one
 *    can lock everyone out at 3 per 10 s, nor buy a fresh bucket by writing the header.
 * 2. Per account and client address: at most `ADDRESS_SIGN_IN_ATTEMPTS` password sign-ins per
 *    window, in Postgres (all replicas). Guesses from one address cannot lock the account for
 *    anyone else. Without a trusted address every client shares the account's bucket (the app
 *    cannot tell them apart): run behind a proxy with TRUSTED_PROXY_HOPS set.
 * 3. Per account, all addresses: a much higher `ACCOUNT_SIGN_IN_CEILING` to slow guessing spread
 *    over many addresses. An address that signed in to the account successfully within
 *    `KNOWN_ADDRESS_DAYS` is exempt, so a distributed attack cannot lock its owner out.
 *
 * Attempts are counted before the password is checked, so parallel guesses cannot slip past; a
 * successful sign-in starts its address's count over.
 */

/** The header carrying the client address to better-auth; whatever a client sends is replaced. */
export const CLIENT_ADDRESS_HEADER = 'x-agile-client-address';
/** Requests per minute per path shared by everyone when there is no trusted client address. */
const SHARED_REQUESTS_PER_MINUTE = 600;
/** Password sign-ins per account and client address per window, failed or not yet known. */
export const ADDRESS_SIGN_IN_ATTEMPTS = 10;
/** Password sign-ins per account per window from all addresses together (known ones excepted). */
export const ACCOUNT_SIGN_IN_CEILING = 100;
const ACCOUNT_WINDOW_MINUTES = 15;
/** How long an address that signed in successfully stays exempt from the account ceiling. */
const KNOWN_ADDRESS_DAYS = 30;
/** Expired rows deleted per attempt (keeps the table small without a scheduled job). */
const PRUNE_BATCH = 100;

/** The request as better-auth must see it: our client-address header, never the client's. */
export function withClientAddress(request: Request, trustedProxyHops: number): Request {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_ADDRESS_HEADER);
  const address = clientAddress(request.headers, trustedProxyHops);
  if (address) headers.set(CLIENT_ADDRESS_HEADER, address);
  // Rebuilt from its parts, not `new Request(request)`: Next.js hands over a request of another
  // class, whose private state this realm's Request cannot read.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    signal: request.signal,
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** better-auth's `rateLimit` and `advanced.ipAddress` settings for the per-address layer. */
export function addressLimitOptions({
  enabled,
  sharedPerMinute = SHARED_REQUESTS_PER_MINUTE,
}: {
  enabled?: boolean;
  sharedPerMinute?: number;
}) {
  return {
    rateLimit: {
      // Unset: better-auth's default (on in production only).
      ...(enabled === undefined ? {} : { enabled }),
      customRules: {
        // No trusted address: one bucket per path for everyone, so a generous one.
        '/**': (request: Request, current: { window: number; max: number }) =>
          request.headers.has(CLIENT_ADDRESS_HEADER)
            ? current
            : { window: 60, max: sharedPerMinute },
      },
    },
    ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
  };
}

const hmac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('hex');
const accountKey = (secret: string, email: string) =>
  hmac(secret, `sign-in:${normalizeEmail(email)}`);
const addressKey = (secret: string, email: string, address: string | null) =>
  address === null
    ? accountKey(secret, email)
    : hmac(secret, `sign-in:${normalizeEmail(email)}|${address}`);
const knownKey = (secret: string, email: string, address: string) =>
  hmac(secret, `known:${normalizeEmail(email)}|${address}`);

const tooManyRequests = (retryAfterSeconds: number) =>
  new APIError(
    'TOO_MANY_REQUESTS',
    { message: 'Too many requests. Please try again later.' },
    { 'X-Retry-After': String(retryAfterSeconds) },
  );

const window = sql.raw(`interval '${ACCOUNT_WINDOW_MINUTES} minutes'`);
const knownFor = sql.raw(`interval '${KNOWN_ADDRESS_DAYS} days'`);

/** One more attempt under `keyHash`; a window that has passed starts over. */
async function bump(db: Db, keyHash: string) {
  const expired = sql`${signInAttempts.windowStartedAt} <= now() - ${window}`;
  const [row] = await db
    .insert(signInAttempts)
    .values({ keyHash, attempts: 1, windowStartedAt: sql`now()` })
    .onConflictDoUpdate({
      target: signInAttempts.keyHash,
      set: {
        attempts: sql`case when ${expired} then 1 else ${signInAttempts.attempts} + 1 end`,
        windowStartedAt: sql`case when ${expired} then now() else ${signInAttempts.windowStartedAt} end`,
      },
    })
    .returning({
      attempts: signInAttempts.attempts,
      retryAfter: sql<number>`ceil(extract(epoch from ${signInAttempts.windowStartedAt} + ${window} - now()))::int`,
    });
  return row;
}

/**
 * Counts one password sign-in and refuses it (429, the same answer as the per-address limiter)
 * past `ADDRESS_SIGN_IN_ATTEMPTS` for this client address, or past `ACCOUNT_SIGN_IN_CEILING` for
 * the account unless the address is a known one. An address without an account counts the same
 * way, so the answer never tells whether it has one. `address` is the trusted client address
 * (null when there is none).
 */
export async function takeSignInAttempt(
  db: Db,
  secret: string,
  email: string,
  address: string | null,
): Promise<void> {
  // Rows whose window has passed; known-address markers (attempts = 0) are kept longer.
  await db.delete(signInAttempts).where(
    inArray(
      signInAttempts.keyHash,
      db
        .select({ keyHash: signInAttempts.keyHash })
        .from(signInAttempts)
        .where(
          or(
            and(
              gt(signInAttempts.attempts, 0),
              lt(signInAttempts.windowStartedAt, sql`now() - ${window}`),
            ),
            lt(signInAttempts.windowStartedAt, sql`now() - ${knownFor}`),
          ),
        )
        .limit(PRUNE_BATCH),
    ),
  );
  const own = await bump(db, addressKey(secret, email, address));
  if (own && own.attempts > ADDRESS_SIGN_IN_ATTEMPTS) {
    throw tooManyRequests(Math.max(1, own.retryAfter));
  }
  if (address === null) return;
  const [known] = await db
    .select({ keyHash: signInAttempts.keyHash })
    .from(signInAttempts)
    .where(
      and(
        eq(signInAttempts.keyHash, knownKey(secret, email, address)),
        gt(signInAttempts.windowStartedAt, sql`now() - ${knownFor}`),
      ),
    )
    .limit(1);
  if (known) return;
  const all = await bump(db, accountKey(secret, email));
  if (all && all.attempts > ACCOUNT_SIGN_IN_CEILING) {
    throw tooManyRequests(Math.max(1, all.retryAfter));
  }
}

/**
 * After a successful password sign-in: this address's count starts over and the address becomes
 * known for the account. The account-wide count is left alone (it slows the other addresses).
 */
export async function clearSignInAttempts(
  db: Db,
  secret: string,
  email: string,
  address: string | null,
): Promise<void> {
  await db
    .delete(signInAttempts)
    .where(eq(signInAttempts.keyHash, addressKey(secret, email, address)));
  if (address === null) return;
  await db
    .insert(signInAttempts)
    .values({ keyHash: knownKey(secret, email, address), attempts: 0, windowStartedAt: sql`now()` })
    .onConflictDoUpdate({ target: signInAttempts.keyHash, set: { windowStartedAt: sql`now()` } });
}
