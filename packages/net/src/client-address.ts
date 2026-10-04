import { isIP } from 'node:net';

/**
 * The client's address as our own reverse proxies recorded it, or null when there is none to
 * trust. Shared by every per-address limit (sign-in, `/api/mcp`) so they all agree.
 *
 * `trustedProxyHops` (TRUSTED_PROXY_HOPS) is how many proxies in front of the app append the
 * address they saw to X-Forwarded-For. The entry that many places from the end was written by the
 * outermost of them, never by the client; anything further left is client-controlled. With 0
 * hops (the app reached directly) the header is never read: the client wrote all of it. Next.js
 * does not give handlers the connection's address, so then there is no address.
 */
export function clientAddress(headers: Headers, trustedProxyHops: number): string | null {
  if (!(trustedProxyHops >= 1)) return null;
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const address = entries[entries.length - trustedProxyHops];
  return address && isIP(address) ? address : null;
}
