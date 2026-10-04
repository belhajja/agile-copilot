import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC_PREFIXES = ['/login', '/signup', '/api/auth'];
// Browser navigations (Jira OAuth start/callback): keep the redirect to /login, not JSON.
const NAVIGATION_API_PREFIXES = ['/api/jira/oauth'];

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Optimistic check only — real authorization happens server-side in requireActor()/currentActor(). */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => under(pathname, p))) return NextResponse.next();
  if (!getSessionCookie(request)) {
    // Fetch clients (the chat) need a status code, not an HTML login page.
    if (under(pathname, '/api') && !NAVIGATION_API_PREFIXES.some((p) => under(pathname, p)))
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
