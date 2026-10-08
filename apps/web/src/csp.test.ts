import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  createNonce,
  securityHeaders,
  strictTransportSecurity,
} from './csp';

const directives = (dev = false) =>
  Object.fromEntries(
    contentSecurityPolicy({ nonce: 'abc123', dev })
      .split(';')
      .map((d) => {
        const [name = '', ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
  );

describe('Content-Security-Policy', () => {
  it('falls back to this origin only', () => {
    expect(directives()['default-src']).toEqual(["'self'"]);
  });

  it('runs only scripts carrying the nonce (and what they load), no eval in production', () => {
    const csp = directives();
    expect(csp['script-src']).toEqual([
      "'self'",
      "'nonce-abc123'",
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
    ]);
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
    // React's development build needs eval for its error overlays.
    expect(directives(true)['script-src']).toContain("'unsafe-eval'");
  });

  it('keeps inline styles (charts, mermaid) without a nonce that would disable them', () => {
    expect(directives()['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('never lets a page load images or open connections to other origins', () => {
    const csp = directives();
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    // blob: for files picked in the chat input (read locally, never uploaded elsewhere).
    expect(csp['connect-src']).toEqual(["'self'", 'blob:']);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('allows no frames, remote media, remote fonts or form posts to other origins', () => {
    const csp = directives();
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['media-src']).toEqual(["'self'"]);
    expect(csp['font-src']).toEqual(["'self'", 'data:']);
    expect(csp['form-action']).toEqual(["'self'"]);
  });

  it('makes a new base64 nonce each time', () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});

describe('other security headers', () => {
  it('sends HSTS only for an https deployment', () => {
    expect(strictTransportSecurity('https://agile.example.com')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(strictTransportSecurity('http://localhost:3000')).toBeNull();
    expect(strictTransportSecurity(undefined)).toBeNull();
  });

  it('sets nosniff, a referrer policy and a permissions policy on every path', () => {
    const [rule] = securityHeaders();
    expect(rule?.source).toBe('/:path*');
    const headers = Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('microphone=()');
    // The CSP is per request (proxy.ts), never a second static one.
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });
});
