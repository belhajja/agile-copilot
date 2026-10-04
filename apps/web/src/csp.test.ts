import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, securityHeaders } from './csp';

const directives = () =>
  Object.fromEntries(
    CONTENT_SECURITY_POLICY.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );

describe('Content-Security-Policy', () => {
  it('never lets a page load images or open connections to other origins', () => {
    const csp = directives();
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('applies to every page', () => {
    expect(securityHeaders()).toEqual([
      {
        source: '/:path*',
        headers: [{ key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY }],
      },
    ]);
  });
});
