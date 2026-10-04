import { describe, expect, it } from 'vitest';
import {
  clientKey,
  createPreAuthLimiter,
  GLOBAL_KEY,
  MCP_GLOBAL_REQUESTS_PER_MINUTE,
  MCP_IP_REQUESTS_PER_MINUTE,
  MCP_TOTAL_REQUESTS_PER_MINUTE,
} from './mcp-ip-limit';

const xff = (value: string) => new Headers({ 'x-forwarded-for': value });

describe('clientKey', () => {
  it('ignores X-Forwarded-For unless a trusted proxy is configured', () => {
    expect(clientKey(xff('203.0.113.7'), 0)).toBe(GLOBAL_KEY);
    expect(clientKey(new Headers(), 0)).toBe(GLOBAL_KEY);
  });

  it('takes the address the trusted proxy appended, never one the client wrote', () => {
    // The client sent "1.1.1.1" itself; our proxy appended the address it saw.
    expect(clientKey(xff('1.1.1.1, 203.0.113.7'), 1)).toBe('203.0.113.7');
    // Two proxies (a CDN, then the ingress): the CDN's view of the client is second from the end.
    expect(clientKey(xff('1.1.1.1, 203.0.113.7, 10.0.0.2'), 2)).toBe('203.0.113.7');
  });

  it('falls back to the shared bucket when the header is missing, short or not an address', () => {
    expect(clientKey(new Headers(), 1)).toBe(GLOBAL_KEY);
    expect(clientKey(xff('203.0.113.7'), 2)).toBe(GLOBAL_KEY);
    expect(clientKey(xff('not-an-ip'), 1)).toBe(GLOBAL_KEY);
    expect(clientKey(xff('global'), 1)).toBe(GLOBAL_KEY);
  });

  it('groups IPv6 clients by /64 (one host owns the whole prefix)', () => {
    expect(clientKey(xff('2001:db8:1:2::1'), 1)).toBe('2001:db8:1:2::/64');
    expect(clientKey(xff('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), 1)).toBe('2001:db8:1:2::/64');
    expect(clientKey(xff('2001:DB8:0001:0002::ffff'), 1)).toBe('2001:db8:1:2::/64');
    expect(clientKey(xff('::ffff:203.0.113.7'), 1)).toBe('203.0.113.7');
  });

  it('unwraps IPv4-mapped addresses written in hex or in full', () => {
    // A client must not get a second budget by writing its IPv4 address another way.
    expect(clientKey(xff('::ffff:cb00:7107'), 1)).toBe('203.0.113.7');
    expect(clientKey(xff('::FFFF:CB00:7107'), 1)).toBe('203.0.113.7');
    expect(clientKey(xff('0:0:0:0:0:ffff:cb00:7107'), 1)).toBe('203.0.113.7');
    expect(clientKey(xff('0:0:0:0:0:ffff:203.0.113.7'), 1)).toBe('203.0.113.7');
  });
});

describe('createPreAuthLimiter', () => {
  it('allows a burst of the per-minute budget per address, then refuses with Retry-After', () => {
    let now = 0;
    const limiter = createPreAuthLimiter({ now: () => now });
    for (let i = 0; i < MCP_IP_REQUESTS_PER_MINUTE; i++) {
      expect(limiter.take('203.0.113.7').allowed).toBe(true);
    }
    const refused = limiter.take('203.0.113.7');
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1 });
    // Another address has its own budget.
    expect(limiter.take('203.0.113.8').allowed).toBe(true);
    // Refills continuously: half a second later, one more request (120 per minute = 2 per second).
    now += 500;
    expect(limiter.take('203.0.113.7').allowed).toBe(true);
    expect(limiter.take('203.0.113.7').allowed).toBe(false);
  });

  it('gives the shared bucket the larger deployment-wide budget', () => {
    const limiter = createPreAuthLimiter({ now: () => 0 });
    for (let i = 0; i < MCP_GLOBAL_REQUESTS_PER_MINUTE; i++) {
      expect(limiter.take(GLOBAL_KEY).allowed).toBe(true);
    }
    expect(limiter.take(GLOBAL_KEY).allowed).toBe(false);
  });

  it('caps all pre-auth traffic at ten times the per-address budget, however many addresses', () => {
    expect(MCP_TOTAL_REQUESTS_PER_MINUTE).toBe(10 * MCP_IP_REQUESTS_PER_MINUTE);
    const limiter = createPreAuthLimiter({ now: () => 0 });
    // Rotating addresses: each new one has a full budget of its own, the ceiling still holds.
    let allowed = 0;
    for (let i = 0; i < MCP_TOTAL_REQUESTS_PER_MINUTE + 300; i++) {
      if (limiter.take(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`).allowed) allowed++;
    }
    expect(allowed).toBe(MCP_TOTAL_REQUESTS_PER_MINUTE);
    expect(limiter.take('192.0.2.200')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    // The shared bucket counts against the same ceiling.
    expect(limiter.take(GLOBAL_KEY).allowed).toBe(false);
  });

  it('spends no address budget on a request the ceiling refused', () => {
    let now = 0;
    const limiter = createPreAuthLimiter({ now: () => now, perMinute: 2, totalPerMinute: 2 });
    expect(limiter.take('10.0.0.1').allowed).toBe(true);
    expect(limiter.take('10.0.0.2').allowed).toBe(true);
    expect(limiter.take('10.0.0.3').allowed).toBe(false); // ceiling
    now += 60_000; // everything refilled
    expect(limiter.take('10.0.0.3').allowed).toBe(true);
    expect(limiter.take('10.0.0.3').allowed).toBe(true);
  });

  it('evicts the least recently used address first', () => {
    let now = 0;
    const limiter = createPreAuthLimiter({ now: () => now, maxClients: 3 });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) limiter.take(ip);
    now += 1;
    limiter.take('10.0.0.1'); // used again: now the most recent
    now += 60_000; // all idle
    limiter.take('10.0.0.4');
    expect(limiter.keys()).toEqual(['10.0.0.3', '10.0.0.1', '10.0.0.4']);
  });

  it('drops idle addresses before one that is over its limit, which keeps its debt', () => {
    let now = 0;
    const limiter = createPreAuthLimiter({ now: () => now, maxClients: 3, perMinute: 2 });
    // A goes over its limit first (oldest in use order), then B and C send one request each.
    expect(limiter.take('10.0.0.1').allowed).toBe(true);
    expect(limiter.take('10.0.0.1').allowed).toBe(true);
    expect(limiter.take('10.0.0.1').allowed).toBe(false);
    limiter.take('10.0.0.2');
    limiter.take('10.0.0.3');
    // 30 s later B and C are full again (idle); A has earned back one request only.
    now += 30_000;
    limiter.take('10.0.0.4');
    expect(limiter.keys()).not.toContain('10.0.0.2');
    expect(limiter.keys()).toContain('10.0.0.1');
    // Not reset: one request, then refused again.
    expect(limiter.take('10.0.0.1').allowed).toBe(true);
    expect(limiter.take('10.0.0.1').allowed).toBe(false);
  });

  it('keeps a bounded number of addresses in memory', () => {
    let now = 0;
    const limiter = createPreAuthLimiter({ now: () => now, maxClients: 3 });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']) {
      limiter.take(ip);
      now += 1;
    }
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
