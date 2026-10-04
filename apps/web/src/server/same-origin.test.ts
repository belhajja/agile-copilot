import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/context', () => ({
  services: () => ({ env: { BETTER_AUTH_URL: 'http://localhost:3200/' } }),
}));

const { isSameOrigin } = await import('./same-origin');

const req = (headers: Record<string, string>) =>
  new Request('http://internal:3000/api/x', { method: 'POST', headers });

describe('isSameOrigin', () => {
  it('accepts our Origin (BETTER_AUTH_URL), whatever host the request reached', () => {
    expect(isSameOrigin(req({ origin: 'http://localhost:3200' }))).toBe(true);
  });

  it('refuses another Origin, even when Sec-Fetch-Site says same-origin', () => {
    expect(isSameOrigin(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(
      isSameOrigin(req({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })),
    ).toBe(false);
    expect(isSameOrigin(req({ origin: 'null' }))).toBe(false);
  });

  it('without Origin, needs Sec-Fetch-Site: same-origin; neither header is refused', () => {
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(isSameOrigin(req({ 'sec-fetch-site': site }))).toBe(false);
    }
    expect(isSameOrigin(req({}))).toBe(false);
  });
});
