import { completeJiraOAuth } from '@agile/connections';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { atlassianOAuth, OAUTH_STATE_COOKIE } from '@/server/atlassian';
import { connectionDeps, requireActor, services } from '@/server/context';

export async function GET(request: NextRequest) {
  const actor = await requireActor();
  const back = new URL('/settings/jira', services().env.BETTER_AUTH_URL);
  const jar = await cookies();
  const stored = jar.get(OAUTH_STATE_COOKIE)?.value ?? '';
  jar.delete({ name: OAUTH_STATE_COOKIE, path: '/api/jira/oauth' });

  // Cookie is `${state}.${orgId}`. arctic's state is base64url (never contains '.'), but org ids are
  // opaque and might, so split on the FIRST '.' only and keep the remainder as the org id.
  const dot = stored.indexOf('.');
  const state = dot === -1 ? '' : stored.slice(0, dot);
  const orgId = dot === -1 ? '' : stored.slice(dot + 1);
  const code = request.nextUrl.searchParams.get('code');
  const oauth = atlassianOAuth();
  // Reject forged callbacks, and flows started in a different workspace than the active one.
  if (
    !oauth ||
    !code ||
    !state ||
    state !== request.nextUrl.searchParams.get('state') ||
    orgId !== actor.orgId
  ) {
    back.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(back);
  }

  const result = await completeJiraOAuth({ ...connectionDeps(), oauth }, actor, code);
  if (result.ok) back.searchParams.set('connected', String(result.created));
  else back.searchParams.set('error', result.code);
  return NextResponse.redirect(back);
}
