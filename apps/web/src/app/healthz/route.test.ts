import { describe, expect, it, vi } from 'vitest';

// The probe must not depend on the database or the identity provider: nothing is mocked because
// the route imports neither (an import would fail here without their settings).
vi.mock('@/server/context', () => {
  throw new Error('the health check must not load the server context');
});

const route = await import('./route');

describe('GET /healthz', () => {
  it('answers 200 without touching the database or the identity provider, never cached', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(route.dynamic).toBe('force-dynamic');
  });
});
