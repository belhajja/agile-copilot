import 'server-only';
import { atlassianOAuthFromEnv } from '@agile/jira';
import { services } from './context';

export const OAUTH_STATE_COOKIE = 'jira_oauth_state';

export function atlassianOAuth() {
  return atlassianOAuthFromEnv(services().env);
}
