import { createHmac } from 'node:crypto';
import { type Db, signInAttempts } from '@agile/db';
import { clientAddress } from '@agile/net';
import { APIError } from 'better-auth/api';
import { inArray, lt, sql } from 'drizzle-orm';
import { normalizeEmail } from './sso';

/**
 * Sign-in limits (P5-R47). Two layers:
 *
 * 1. Per client address: better-auth's own limiter (3 sign-ins per 10 s per address, 100 requests
 *    per 10 s on other paths; in memory, per process). It is fed the address from `clientAddress`
 *    (TRUSTED_PROXY_HOPS, the same rule as `/api/mcp`) through a header the app sets on every
 *    request, never X-Forwarded-For as the client sent it. Without a trusted address (the app
 *    reached directly) all requests share one bucket per path with a generous ceiling, so no one
 *    can lock everyone out at 3 per 10 s, nor buy a fresh bucket by writing the header.
 * 2. Per account: at most `ACCOUNT_SIGN_IN_ATTEMPTS` password sign-ins per address per window,
 *    in Postgres (all replicas), whatever the client address. Attempts are counted before the
 *    password is checked, so parallel guesses cannot slip past; a successful sign-in starts over.
 */

/** The header carrying the client address to better-auth; whatever a client sends is replaced. */
export const CLIENT_ADDRESS_HEADER = 'x-agile-client-address';
/** Requests per minute per path shared by everyone when there is no trusted client address. */
export const SHARED_REQUESTS_PER_MINUTE = 600;
/** Password sign-ins per account (normalised address) per window, failed or not yet known. */
export const ACCOUNT_SIGN_IN_ATTEMPTS = 10;
export const ACCOUNT_WINDOW_MINUTES = 15;
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

const keyOf = (secret: string, email: string) =>
  createHmac('sha256', secret)
    .update(`sign-in:${normalizeEmail(email)}`)
    .digest('hex');

const tooManyRequests = (retryAfterSeconds: number) =>
  new APIError(
    'TOO_MANY_REQUESTS',
    { message: 'Too many requests. Please try again later.' },
    { 'X-Retry-After': String(retryAfterSeconds) },
  );

/**
 * Counts one password sign-in for this address and refuses it (429, the same answer as the
 * per-address limiter) once the window holds more than `ACCOUNT_SIGN_IN_ATTEMPTS`. An address
 * without an account counts the same way, so the answer never tells whether it has one.
 */
export async function takeSignInAttempt(db: Db, secret: string, email: string): Promise<void> {
  const window = sql.raw(`interval '${ACCOUNT_WINDOW_MINUTES} minutes'`);
  const expired = sql`${signInAttempts.windowStartedAt} <= now() - ${window}`;
  const [row] = await db
    .insert(signInAttempts)
    .values({ keyHash: keyOf(secret, email), attempts: 1, windowStartedAt: sql`now()` })
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
  await db.delete(signInAttempts).where(
    inArray(
      signInAttempts.keyHash,
      db
        .select({ keyHash: signInAttempts.keyHash })
        .from(signInAttempts)
        .where(lt(signInAttempts.windowStartedAt, sql`now() - ${window}`))
        .limit(PRUNE_BATCH),
    ),
  );
  if (row && row.attempts > ACCOUNT_SIGN_IN_ATTEMPTS) {
    throw tooManyRequests(Math.max(1, row.retryAfter));
  }
}

/** After a successful password sign-in: the account's count starts over. */
export async function clearSignInAttempts(db: Db, secret: string, email: string): Promise<void> {
  await db.delete(signInAttempts).where(sql`${signInAttempts.keyHash} = ${keyOf(secret, email)}`);
}
