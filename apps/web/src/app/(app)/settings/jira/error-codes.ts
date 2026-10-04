/**
 * The codes with a sentence under `jira.errors` (not the nested `blocked` group): what the Jira
 * settings page shows for `?error=` (the OAuth routes' redirects). A test ties it to the messages.
 */
export const JIRA_ERROR_CODES = [
  'invalid_input',
  'blocked_url',
  'unauthorized',
  'forbidden',
  'not_found',
  'not_jira',
  'wrong_deployment',
  'rate_limited',
  'unreachable',
  'duplicate',
  'forbidden_role',
  'oauth_failed',
  'oauth_no_sites',
  'oauth_expired',
] as const;

/** Jira status category keys with a label (`boards.jiraCategories.*`); any other key is shown as is. */
export const JIRA_CATEGORIES = ['new', 'indeterminate', 'done', 'undefined'] as const;
