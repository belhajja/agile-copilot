import { describe, expect, it } from 'vitest';
import { CLIENT_ADDRESS_HEADER, withClientAddress } from './sign-in-limits';

/**
 * Next.js hands route handlers a request whose class is not this realm's `Request`, so
 * `new Request(request)` cannot read its private state: the request is rebuilt from its parts.
 */
describe('withClientAddress', () => {
  const foreign = (method: string, body: string | null) => {
    const native = new Request('https://app.test/api/auth/sign-in/email', {
      method,
      headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7', [CLIENT_ADDRESS_HEADER]: '9.9.9.9' },
      body,
    });
    // Same shape, other class (as from another realm).
    return {
      url: native.url,
      method: native.method,
      headers: native.headers,
      body: native.body,
      signal: native.signal,
    } as unknown as Request;
  };

  it('rebuilds a POST from a request of another realm, body and all, with our address', async () => {
    const out = withClientAddress(foreign('POST', '{"email":"a@b.c"}'), 1);
    expect(out.method).toBe('POST');
    expect(out.url).toBe('https://app.test/api/auth/sign-in/email');
    expect(out.headers.get(CLIENT_ADDRESS_HEADER)).toBe('203.0.113.7');
    expect(await out.text()).toBe('{"email":"a@b.c"}');
  });

  it('drops a client-sent address header when there is no trusted address', () => {
    const out = withClientAddress(foreign('GET', null), 0);
    expect(out.headers.has(CLIENT_ADDRESS_HEADER)).toBe(false);
    expect(out.headers.get('x-forwarded-for')).toBe('1.1.1.1, 203.0.113.7');
  });
});
