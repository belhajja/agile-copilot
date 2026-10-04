import { isIPv4 } from 'node:net';
import { serverEnv } from '@agile/config';
import { clientAddress } from '@agile/net';

/**
 * Pre-authentication limit of `/api/mcp` (P5-R36): a cheap in-memory token bucket per client
 * address, checked before the token is looked up, so a flood of made-up tokens cannot turn into
 * a flood of database queries. The per-person limit (`MCP_RATE_LIMIT_PER_MINUTE`, in Postgres)
 * still applies to authenticated requests.
 *
 * The client address comes from X-Forwarded-For only when `TRUSTED_PROXY_HOPS` says how many
 * proxies append to it (`clientAddress` from @agile/net, shared with the sign-in limits). Next.js
 * does not give route handlers the connection's address, so without a trusted proxy every request
 * shares one deployment-wide bucket (a larger budget). The buckets live in each server process: with several replicas, each has its own. On top of the
 * per-address buckets, one ceiling bounds all pre-auth traffic of the process (P5-R42).
 */

/** Requests per client address per minute, before authentication. */
export const MCP_IP_REQUESTS_PER_MINUTE = 120;
/** Requests per minute for the shared bucket (no trusted proxy, or no usable address). */
export const MCP_GLOBAL_REQUESTS_PER_MINUTE = 1200;
/**
 * Ceiling on ALL pre-auth traffic of the process (P5-R42), addressed or not: rotating addresses
 * gives each a fresh budget, never more than this in total.
 */
export const MCP_TOTAL_REQUESTS_PER_MINUTE = 10 * MCP_IP_REQUESTS_PER_MINUTE;
/** Addresses kept in memory at most (least recently used dropped first, idle before busy). */
export const MAX_TRACKED_CLIENTS = 10_000;
/** The shared bucket's key (never an address: `isIP` refuses it). */
export const GLOBAL_KEY = 'global';

const MINUTE_MS = 60_000;
/** Busy (not yet refilled) entries skipped at most per eviction, so eviction stays O(1). */
const EVICTION_SCAN = 16;

/** The eight 16-bit groups of a valid IPv6 address (a dotted IPv4 tail becomes two groups). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number);
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail = ''] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = text.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** The bucket a request counts against: its client address (IPv6 by /64), else `GLOBAL_KEY`. */
export function clientKey(headers: Headers, trustedProxyHops: number): string {
  const address = clientAddress(headers, trustedProxyHops);
  if (!address) return GLOBAL_KEY;
  if (isIPv4(address)) return address;
  const g = ipv6Groups(address);
  // IPv4-mapped (::ffff:a.b.c.d, in any spelling): the IPv4 client's own bucket.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi = 0, lo = 0] = g.slice(6);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

export type LimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

export function createPreAuthLimiter({
  perMinute = MCP_IP_REQUESTS_PER_MINUTE,
  globalPerMinute = MCP_GLOBAL_REQUESTS_PER_MINUTE,
  totalPerMinute = MCP_TOTAL_REQUESTS_PER_MINUTE,
  maxClients = MAX_TRACKED_CLIENTS,
  now = Date.now,
}: {
  perMinute?: number;
  globalPerMinute?: number;
  totalPerMinute?: number;
  maxClients?: number;
  now?: () => number;
} = {}) {
  /** In use order: the first entry is the least recently used (Map keeps insertion order). */
  const buckets = new Map<string, Bucket>();
  const total: Bucket = { tokens: totalPerMinute, at: now() };
  const capacityOf = (key: string) => (key === GLOBAL_KEY ? globalPerMinute : perMinute);
  const refill = (bucket: Bucket, capacity: number, t: number) => {
    bucket.tokens = Math.min(capacity, bucket.tokens + ((t - bucket.at) * capacity) / MINUTE_MS);
    bucket.at = t;
  };
  const retryAfter = (bucket: Bucket, capacity: number) => ({
    allowed: false as const,
    retryAfterSeconds: Math.max(1, Math.ceil(((1 - bucket.tokens) * MINUTE_MS) / capacity / 1000)),
  });

  /**
   * Makes room for one address: the least recently used idle (refilled) bucket. Busy ones met on
   * the way move to the back, so a client over its limit keeps its debt while idle entries exist
   * (at most EVICTION_SCAN skips; beyond that the least recently used goes).
   */
  const evict = (t: number) => {
    for (let i = 0; i < EVICTION_SCAN; i++) {
      const first = buckets.entries().next();
      if (first.done) return;
      const [key, bucket] = first.value;
      buckets.delete(key);
      refill(bucket, capacityOf(key), t);
      if (bucket.tokens >= capacityOf(key)) return;
      buckets.set(key, bucket);
    }
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  };

  return {
    take(key: string): LimitResult {
      const t = now();
      const capacity = capacityOf(key);
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key); // re-inserted below: most recently used
        refill(bucket, capacity, t);
      } else {
        if (buckets.size >= maxClients) evict(t);
        bucket = { tokens: capacity, at: t };
      }
      buckets.set(key, bucket);
      refill(total, totalPerMinute, t);
      if (bucket.tokens < 1) return retryAfter(bucket, capacity);
      if (total.tokens < 1) return retryAfter(total, totalPerMinute);
      bucket.tokens -= 1;
      total.tokens -= 1;
      return { allowed: true };
    },
    size: () => buckets.size,
    /** Tracked keys, least recently used first (tests). */
    keys: () => [...buckets.keys()],
  };
}

let limiter: ReturnType<typeof createPreAuthLimiter> | undefined;

/** A 429 for a client over its pre-auth budget, or null to go on. Reads no database. */
export function preAuthLimit(request: Request): Response | null {
  limiter ??= createPreAuthLimiter();
  const result = limiter.take(clientKey(request.headers, serverEnv().TRUSTED_PROXY_HOPS));
  if (result.allowed) return null;
  return Response.json(
    { error: 'rate_limited' },
    { status: 429, headers: { 'retry-after': String(result.retryAfterSeconds) } },
  );
}
