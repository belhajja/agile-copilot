/**
 * What an approval card shows, in this order: every input field a Jira write can send, plus the
 * site it goes to (a test checks the list against the tool catalog, so a new field cannot be sent
 * without being shown).
 */
export const APPROVAL_FIELDS = [
  'site',
  'issueKey',
  'projectKey',
  'issueType',
  'summary',
  'transitionId',
  'assignee',
  'labels',
  'description',
  'body',
  'comment',
] as const;

/** Free text the Jira backends convert from Markdown to Jira wiki markup before sending. */
export const CONVERTED_FIELDS: ReadonlySet<string> = new Set(['description', 'body', 'comment']);
