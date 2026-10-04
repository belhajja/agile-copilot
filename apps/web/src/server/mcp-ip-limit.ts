import { isIPv4, isIPv6 } from 'node:net';
import { serverEnv } from '@agile/config';

/**
 * Pre-authentication limit of `/api/mcp` (P5-R36): a cheap in-memory token bucket per client
 * address, checked before the token is looked up, so a flood of made-up tokens cannot turn into
 * a flood of database queries. The per-person limit (`MCP_RATE_LIMIT_PER_MINUTE`, in Postgres)
 * still applies to authenticated requests.
 *
 * The client address comes from X-Forwarded-For only when `TRUSTED_PROXY_HOPS` says how many
 * proxies append to it (the entry that many places from the end, written by our own proxy, never
 * one the client wrote). Next.js does not give route handlers the connection's address, so
 * without a trusted proxy every request shares one deployment-wide bucket (a larger budget). The
 * buckets live in each server process: with several replicas, each has its own.
 */

/** Requests per client address per minute, before authentication. */
export const MCP_IP_REQUESTS_PER_MINUTE = 120;
/** Requests per minute for the shared bucket (no trusted proxy, or no usable address). */
export const MCP_GLOBAL_REQUESTS_PER_MINUTE = 1200;
/** Addresses kept in memory at most; idle (full) buckets are dropped first. */
export const MAX_TRACKED_CLIENTS = 10_000;
/** The shared bucket's key (never an address: `isIP` refuses it). */
export const GLOBAL_KEY = 'global';

const MINUTE_MS = 60_000;

/** The /64 prefix of an IPv6 address (one host usually owns the whole prefix). */
function ipv6Prefix(address: string): string {
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/** The bucket a request counts against: its client address (IPv6 by /64), else `GLOBAL_KEY`. */
export function clientKey(headers: Headers, trustedProxyHops: number): string {
  if (trustedProxyHops < 1) return GLOBAL_KEY;
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const address = entries[entries.length - trustedProxyHops];
  if (!address) return GLOBAL_KEY;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (isIPv4(address)) return address;
  if (isIPv6(address)) return ipv6Prefix(address);
  return GLOBAL_KEY;
}

export type LimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

export function createPreAuthLimiter({
  perMinute = MCP_IP_REQUESTS_PER_MINUTE,
  globalPerMinute = MCP_GLOBAL_REQUESTS_PER_MINUTE,
  maxClients = MAX_TRACKED_CLIENTS,
  now = Date.now,
}: {
  perMinute?: number;
  globalPerMinute?: number;
  maxClients?: number;
  now?: () => number;
} = {}) {
  const buckets = new Map<string, Bucket>();
  const capacityOf = (key: string) => (key === GLOBAL_KEY ? globalPerMinute : perMinute);
  const refill = (key: string, bucket: Bucket, t: number) => {
    const capacity = capacityOf(key);
    bucket.tokens = Math.min(capacity, bucket.tokens + ((t - bucket.at) * capacity) / MINUTE_MS);
    bucket.at = t;
  };

  /** Makes room for one more address: idle buckets first, then the oldest ones. */
  const evict = (t: number) => {
    for (const [key, bucket] of buckets) {
      refill(key, bucket, t);
      if (bucket.tokens >= capacityOf(key)) buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size < maxClients) break;
      buckets.delete(key);
    }
  };

  return {
    take(key: string): LimitResult {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxClients) evict(t);
        bucket = { tokens: capacityOf(key), at: t };
        buckets.set(key, bucket);
      } else {
        refill(key, bucket, t);
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true };
      }
      const rate = capacityOf(key) / MINUTE_MS;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000)),
      };
    },
    size: () => buckets.size,
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
