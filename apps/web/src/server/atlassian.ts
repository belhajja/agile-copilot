import 'server-only';
import { createAtlassianOAuth } from '@agile/jira';
import { services } from './context';

export const OAUTH_STATE_COOKIE = 'jira_oauth_state';

export function atlassianOAuth() {
  const { env } = services();
  if (!env.ATLASSIAN_OAUTH_CLIENT_ID || !env.ATLASSIAN_OAUTH_CLIENT_SECRET) return null;
  return createAtlassianOAuth({
    clientId: env.ATLASSIAN_OAUTH_CLIENT_ID,
    clientSecret: env.ATLASSIAN_OAUTH_CLIENT_SECRET,
    redirectUri: new URL('/api/jira/oauth/callback', env.BETTER_AUTH_URL).toString(),
  });
}
