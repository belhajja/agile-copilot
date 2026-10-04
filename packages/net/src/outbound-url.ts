// DNS can change between this check and the connection (DNS rebinding): requests to user-supplied
// hosts go through createOutboundFetch / createPinnedAgents (pinned.ts), which re-apply this rule
// to the very address they connect to. Callers must also never follow redirects.
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type Resolver = (hostname: string) => Promise<string[]>;
export type BlockedUrlReason =
  | 'invalid_url'
  | 'scheme'
  | 'credentials'
  | 'blocked_host'
  | 'localhost'
  | 'private_address'
  | 'unresolvable';
/** `reason` is English for logs/tests; UIs translate `code` (with `host`) instead. */
export type OutboundUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: BlockedUrlReason; reason: string; host?: string };

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

const ALWAYS_BLOCKED = new Set(['metadata.google.internal', 'metadata']);

/** Cloud metadata hosts: refused even when allowlisted. */
export const isAlwaysBlockedHost = (host: string) => ALWAYS_BLOCKED.has(host);

/** The host (or a parent domain) is on the operator's private-host allowlist. */
export const isAllowlistedHost = (host: string, allowed: readonly string[]) =>
  allowed.some((d) => host === d || host.endsWith(`.${d}`));

/** A globally routable unicast address (not private, loopback, link-local, reserved…). */
export const isPublicAddress = (address: string): boolean =>
  ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';

/**
 * Guards server-side requests to user-supplied URLs (SSRF): only http(s), no embedded
 * credentials, and no private/reserved addresses unless the operator allowlisted the host.
 */
export async function checkOutboundUrl(
  raw: string,
  opts: { allowedPrivateHosts: readonly string[]; resolve?: Resolver },
): Promise<OutboundUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'invalid_url', reason: 'Not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'scheme', reason: 'Only http and https URLs are allowed' };
  }
  if (url.username || url.password)
    return { ok: false, code: 'credentials', reason: 'URLs must not contain credentials' };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isAlwaysBlockedHost(host)) {
    return { ok: false, code: 'blocked_host', reason: `Host ${host} is blocked`, host };
  }
  if (isAllowlistedHost(host, opts.allowedPrivateHosts)) return { ok: true, url };
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return {
      ok: false,
      code: 'localhost',
      reason: 'localhost is a private address; ask your administrator to allow it',
      host,
    };
  }

  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (opts.resolve ?? defaultResolver)(host);
    } catch {
      return { ok: false, code: 'unresolvable', reason: `Could not resolve ${host}`, host };
    }
  }
  if (addresses.length === 0) {
    return { ok: false, code: 'unresolvable', reason: `Could not resolve ${host}`, host };
  }

  for (const address of addresses) {
    const range = ipaddr.process(address).range();
    if (range !== 'unicast') {
      return {
        ok: false,
        code: 'private_address',
        host,
        reason: `${host} points to a private or reserved address (${range}); ask your administrator to allow this host`,
      };
    }
  }
  return { ok: true, url };
}
