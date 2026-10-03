import { canManageConnections } from '@agile/auth';
import { ATLASSIAN_SCOPES } from '@agile/jira';
import { generateState } from 'arctic';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { atlassianOAuth, OAUTH_STATE_COOKIE } from '@/server/atlassian';
import { requireActor, services } from '@/server/context';

export async function GET() {
  const actor = await requireActor();
  const back = new URL('/settings/jira', services().env.BETTER_AUTH_URL);
  const oauth = atlassianOAuth();
  if (!oauth || !canManageConnections(actor.roles)) {
    back.searchParams.set('error', oauth ? 'forbidden_role' : 'oauth_failed');
    return NextResponse.redirect(back);
  }
  const state = generateState();
  (await cookies()).set(OAUTH_STATE_COOKIE, `${state}.${actor.orgId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/jira/oauth',
    maxAge: 600,
  });
  return NextResponse.redirect(oauth.createAuthorizationURL(state, [...ATLASSIAN_SCOPES]));
}
