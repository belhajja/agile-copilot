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
    // blob: for files picked in the chat input (read locally, never uploaded elsewhere).
    expect(csp['connect-src']).toEqual(["'self'", 'blob:']);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('allows no frames, remote media, remote fonts or form posts to other origins', () => {
    const csp = directives();
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['media-src']).toEqual(["'self'"]);
    expect(csp['font-src']).toEqual(["'self'", 'data:']);
    expect(csp['form-action']).toEqual(["'self'"]);
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
