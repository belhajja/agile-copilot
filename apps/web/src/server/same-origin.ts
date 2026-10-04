import { services } from '@/server/context';

// BETTER_AUTH_URL never changes while the process runs: compute its origin once.
let cachedOrigin: string | undefined;
const allowedOrigin = () => {
  cachedOrigin ??= new URL(services().env.BETTER_AUTH_URL).origin;
  return cachedOrigin;
};

/**
 * Same-origin only, for cookie-authenticated POST routes (the session cookie is SameSite=Lax;
 * this is a second, explicit check): the Origin must be ours, or, when the browser sent none,
 * Sec-Fetch-Site must say same-origin. Anything else, including a request with neither header,
 * is refused.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === allowedOrigin();
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
