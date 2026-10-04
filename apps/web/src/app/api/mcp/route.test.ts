import { beforeEach, describe, expect, it, vi } from 'vitest';

// The gateway's own tests (Testcontainers) cover tokens, audit and the MCP protocol: these pin
// what the route adds in front of it — the pre-auth per-address limit, before any database work.
const env = { TRUSTED_PROXY_HOPS: 0 };
vi.mock('@agile/config', () => ({ serverEnv: () => env }));

const deps = { db: { stub: true } };
const mcpDeps = vi.fn(() => deps);
vi.mock('@/server/mcp', () => ({ mcpDeps: () => mcpDeps() }));

const handleMcpHttpRequest = vi.fn(async (_deps: unknown, _request: Request) =>
  Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
);
vi.mock('@agile/mcp-gateway', () => ({
  handleMcpHttpRequest: (d: unknown, r: Request) => handleMcpHttpRequest(d, r),
}));

let route: typeof import('./route');

const post = (headers: Record<string, string> = {}) =>
  route.POST(
    new Request('http://localhost:3200/api/mcp', {
      method: 'POST',
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      headers: {
        authorization: 'Bearer acp_org.x',
        'content-type': 'application/json',
        ...headers,
      },
    }),
  );

const corsHeaders = (res: Response) =>
  [...res.headers.keys()].filter((k) => k.startsWith('access-control-'));

describe('POST /api/mcp', () => {
  beforeEach(async () => {
    // A fresh module: the in-memory buckets start full in every test.
    vi.resetModules();
    env.TRUSTED_PROXY_HOPS = 0;
    mcpDeps.mockClear();
    handleMcpHttpRequest.mockClear();
    route = await import('./route');
  });

  it('runs on the Node runtime, never cached, and answers POST only', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    // Next answers 405 for every method a route does not export.
    const exported = route as Record<string, unknown>;
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      expect(exported[method], method).toBeUndefined();
    }
  });

  it('hands the request, untouched, to the gateway, without CORS headers', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(handleMcpHttpRequest).toHaveBeenCalledTimes(1);
    const [passedDeps, passed] = handleMcpHttpRequest.mock.calls[0] ?? [];
    expect(passedDeps).toBe(deps);
    expect(passed?.headers.get('authorization')).toBe('Bearer acp_org.x');
    expect(corsHeaders(res)).toEqual([]);
  });

  it('answers 429 to excess requests from one address before any token lookup', async () => {
    env.TRUSTED_PROXY_HOPS = 1;
    const from = (ip: string) => post({ 'x-forwarded-for': ip });
    for (let i = 0; i < 120; i++) expect((await from('203.0.113.7')).status).toBe(200);
    expect(mcpDeps).toHaveBeenCalledTimes(120);

    const refused = await from('203.0.113.7');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(corsHeaders(refused)).toEqual([]);
    // Neither the database dependencies nor the gateway were touched for the refused request.
    expect(mcpDeps).toHaveBeenCalledTimes(120);
    expect(handleMcpHttpRequest).toHaveBeenCalledTimes(120);

    // Another client behind the same proxy is not affected.
    expect((await from('203.0.113.8')).status).toBe(200);
  });

  it('never lets a client pick its bucket through X-Forwarded-For without a trusted proxy', async () => {
    // Without TRUSTED_PROXY_HOPS every request shares one deployment-wide bucket, whatever
    // address the client claims.
    for (let i = 0; i < 1200; i++) {
      expect((await post({ 'x-forwarded-for': `198.51.100.${i % 250}` })).status).toBe(200);
    }
    expect((await post({ 'x-forwarded-for': '192.0.2.1' })).status).toBe(429);
    expect(handleMcpHttpRequest).toHaveBeenCalledTimes(1200);
  });
});
