import { lookup as dnsLookup } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { RedirectBlockedError } from './http';
import { isAllowlistedHost, isPublicAddress, type Resolver } from './outbound-url';

/** The deployment's outbound rule: private addresses only for operator-allowlisted hosts. */
export interface OutboundPolicy {
  allowedPrivateHosts: readonly string[];
  /** Name resolution (tests inject one); default: the system resolver. */
  resolve?: Resolver;
}

/** A connection was about to reach a private/reserved address the policy does not allow. */
export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError';
  readonly code = 'blocked_url';
  constructor(readonly host: string) {
    super(`Connection to ${host} blocked: it resolves to a private or reserved address`);
  }
}

const systemResolve: Resolver = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses.map((a) => a.address)),
    ),
  );

/**
 * A `lookup` for sockets that resolves each host once, refuses the connection when any address is
 * private/reserved (unless the host is allowlisted), and hands that same validated address to the
 * socket. Validation and connection share one resolution, so DNS rebinding between
 * `checkOutboundUrl` and the request cannot swap in an internal address.
 */
export function createPinnedLookup(policy: OutboundPolicy): LookupFunction {
  const resolve = policy.resolve ?? systemResolve;
  return (hostname, options, callback) => {
    const host = hostname.toLowerCase();
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(
            Object.assign(new Error(`Could not resolve ${host}`), { code: 'ENOTFOUND' }),
            '',
          );
          return;
        }
        if (
          !isAllowlistedHost(host, policy.allowedPrivateHosts) &&
          !addresses.every(isPublicAddress)
        ) {
          callback(new BlockedAddressError(host), '');
          return;
        }
        const entries = addresses.map((address) => ({
          address,
          family: ipaddr.parse(address).kind() === 'ipv6' ? 6 : 4,
        }));
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const usable = wanted ? entries.filter((e) => e.family === wanted) : entries;
        const first = usable[0];
        if (!first) {
          callback(
            Object.assign(new Error(`No IPv${wanted} address for ${host}`), { code: 'ENOTFOUND' }),
            '',
          );
          return;
        }
        if (options.all) callback(null, usable);
        else callback(null, first.address, first.family);
      },
      (error: unknown) =>
        callback(
          Object.assign(new Error(`Could not resolve ${host}`), {
            code: (error as { code?: string }).code ?? 'ENOTFOUND',
          }),
          '',
        ),
    );
  };
}

/** IP literals never reach `lookup`: check them against the same rule up front. */
function assertLiteralAllowed(hostname: string, policy: OutboundPolicy) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!ipaddr.isValid(host) || isAllowlistedHost(host, policy.allowedPrivateHosts)) return;
  if (!isPublicAddress(host)) throw new BlockedAddressError(host);
}

const agents = new Map<string, Agent>();

/** One undici Agent per allowlist (connection reuse); a fresh one when a test injects `resolve`. */
function agentFor(policy: OutboundPolicy): Agent {
  const make = () => new Agent({ connect: { lookup: createPinnedLookup(policy) } });
  if (policy.resolve) return make();
  const key = [...policy.allowedPrivateHosts].sort().join(',');
  let agent = agents.get(key);
  if (!agent) {
    agent = make();
    agents.set(key, agent);
  }
  return agent;
}

/**
 * `fetch` for user-supplied hosts: never follows redirects (like `fetchNoRedirect`) and connects
 * only to addresses the policy allows, pinned at connect time. Accepts a string or URL.
 */
export function createOutboundFetch(policy: OutboundPolicy): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request)
      throw new TypeError('createOutboundFetch takes a URL, not a Request');
    const url = new URL(String(input));
    assertLiteralAllowed(url.hostname, policy);
    const res = await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: 'manual',
      dispatcher: agentFor(policy),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new RedirectBlockedError(res.status);
    }
    return res as unknown as Response;
  }) as typeof fetch;
}

/** Node http(s) agents with the pinned lookup, for axios-based clients (jira.js v5). */
export function createPinnedAgents(policy: OutboundPolicy): {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
} {
  const lookup = createPinnedLookup(policy);
  return { httpAgent: new HttpAgent({ lookup }), httpsAgent: new HttpsAgent({ lookup }) };
}

/** True when `e` (or an error in its `cause` chain) is a blocked connection. */
export function isBlockedAddressError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if ((cur as { name?: unknown }).name === 'BlockedAddressError') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
