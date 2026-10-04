import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import fr from '../../messages/fr.json';
import { JIRA_CATEGORIES, JIRA_ERROR_CODES } from '../app/(app)/settings/jira/error-codes';
import { TOOL_LABELS } from '../components/agent/tool-labels';
import { AUTH_ERROR_CODES } from './auth-error';
import { allowedCode } from './error-code';

/** The plain-sentence keys of a message group (nested groups and `unknown` left out). */
const sentences = (group: Record<string, unknown>) =>
  Object.entries(group)
    .filter(([k, v]) => typeof v === 'string' && k !== 'unknown')
    .map(([k]) => k)
    .sort();

/**
 * Message keys looked up from input we do not control (query strings, model tool names, Jira
 * data, HTTP answers) go through these allowlists, never `t.has`: each list is exactly the keys
 * that have a sentence, in both languages.
 */
describe('allowlisted message keys', () => {
  it.each(Object.entries({ en, fr }))('%s: each list matches its messages', (_l, m) => {
    expect([...JIRA_ERROR_CODES].sort()).toEqual(sentences(m.jira.errors));
    expect([...JIRA_CATEGORIES].sort()).toEqual(sentences(m.boards.jiraCategories));
    expect([...TOOL_LABELS].sort()).toEqual(sentences(m.agent.tools));
    expect([...AUTH_ERROR_CODES].sort()).toEqual(sentences(m.auth.errors));
  });

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'blocked',
    'blocked.scheme',
    'errors.forbidden',
    ['forbidden'],
  ])('refuses %j (prototype keys, namespaces, paths, arrays)', (value) => {
    for (const list of [JIRA_ERROR_CODES, JIRA_CATEGORIES, TOOL_LABELS, AUTH_ERROR_CODES]) {
      expect(allowedCode(value, list)).toBeNull();
    }
  });
});
