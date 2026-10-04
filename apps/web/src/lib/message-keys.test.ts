import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import fr from '../../messages/fr.json';
import { JIRA_CATEGORIES, JIRA_ERROR_CODES } from '../app/(app)/settings/jira/error-codes';
import { TOOL_LABELS } from '../components/agent/tool-labels';
import { AUTH_ERROR_CODES } from './auth-error';
import { allowedCode } from './error-code';
import { INVITATION_PAGE_ERRORS, SSO_ERROR_CODES } from './sso-error-codes';

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

  it('explains every SSO error query code and invitation page error with an auth sentence', () => {
    for (const code of [...SSO_ERROR_CODES, ...INVITATION_PAGE_ERRORS]) {
      expect(AUTH_ERROR_CODES).toContain(code);
    }
    // The codes the identity provider round trip and the Task 5 guards send back.
    for (const code of [
      'account_not_linked',
      'oauth_provider_not_found',
      'state_mismatch',
      'access_denied',
    ]) {
      expect(SSO_ERROR_CODES).toContain(code);
    }
    for (const code of [
      'PASSWORD_LOGIN_DISABLED',
      'SIGN_UP_NOT_ALLOWED',
      'ID_TOKEN_SIGN_IN_DISABLED',
      'SCOPES_NOT_ALLOWED',
      'INVALID_CALLBACK_URL',
      'INVALID_ORIGIN',
      'PROVIDER_NOT_FOUND',
    ]) {
      expect(AUTH_ERROR_CODES).toContain(code);
    }
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
    for (const list of [
      JIRA_ERROR_CODES,
      JIRA_CATEGORIES,
      TOOL_LABELS,
      AUTH_ERROR_CODES,
      SSO_ERROR_CODES,
    ]) {
      expect(allowedCode(value, list)).toBeNull();
    }
  });
});
