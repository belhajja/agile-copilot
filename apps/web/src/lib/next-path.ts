/** Paths inside this app: one leading slash, then URL-safe path and query characters only. */
const IN_APP_PATH = /^\/(?![/\\])[\w\-./~%?=&]*$/;

/**
 * Where to go after signing in: only a path inside this app ("/invitations/abc"), never another
 * origin ("//evil.example", "https://…", "/\\evil", nor their percent-encoded forms). Anything
 * else falls back to "/".
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string' || next.length > 512 || !IN_APP_PATH.test(next)) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return '/';
  }
  // No empty segment or backslash anywhere, encoded or not ("/a//b", "/.//evil", "/%5Cevil").
  if ([next, decoded].some((p) => p.includes('//') || p.includes('\\'))) return '/';
  return next;
}

/** The login page, remembering `next` when it is a safe path other than the home page. */
export function loginPath(next: unknown): string {
  const safe = safeNextPath(next);
  return safe === '/' ? '/login' : `/login?next=${encodeURIComponent(safe)}`;
}
