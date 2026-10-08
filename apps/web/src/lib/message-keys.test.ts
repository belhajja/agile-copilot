import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import fr from '../../messages/fr.json';
import { BILLING_ERROR_CODES, BILLING_STATUSES } from '../app/(app)/settings/billing/billing-codes';
import {
  BOARD_ERROR_CODES,
  JIRA_CATEGORIES,
  JIRA_ERROR_CODES,
} from '../app/(app)/settings/jira/error-codes';
import { LLM_ERROR_CODES } from '../app/(app)/settings/llm/error-codes';
import { MCP_ERROR_CODES } from '../app/(app)/settings/mcp/error-codes';
import { SETTINGS_ERROR_CODES } from '../app/(app)/settings/workspace/error-codes';
import { TOOL_LABELS } from '../components/agent/tool-labels';
import {
  DASHBOARD_CHARTS,
  DASHBOARD_CODES,
  DASHBOARD_COLUMNS,
  DASHBOARD_EMPTY_REASONS,
  DASHBOARD_HINTS,
  DASHBOARD_METRICS,
  DASHBOARD_NOTES,
  DASHBOARD_SERIES,
  QUERY_GROUPS,
} from '../components/dashboard/message-keys';
import { AUTH_ERROR_CODES } from './auth-error';
import { allowedCode, BLOCKED_REASONS } from './error-code';
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
    expect([...BILLING_ERROR_CODES].sort()).toEqual(sentences(m.billing.errors));
    expect([...BILLING_STATUSES].sort()).toEqual(sentences(m.billing.status));
    expect([...SETTINGS_ERROR_CODES].sort()).toEqual(sentences(m.workspace.errors));
    expect([...MCP_ERROR_CODES].sort()).toEqual(sentences(m.mcp.errors));
    expect([...LLM_ERROR_CODES].sort()).toEqual(sentences(m.llm.errors));
    expect([...BOARD_ERROR_CODES].sort()).toEqual(sentences(m.boards.errors));
    for (const group of [m.llm.errors.blocked, m.jira.errors.blocked, m.delivery.errors.blocked]) {
      expect([...BLOCKED_REASONS].sort()).toEqual(sentences(group));
    }
    expect([...DASHBOARD_CODES].sort()).toEqual(sentences(m.dashboards.codes));
    expect([...DASHBOARD_CHARTS].sort()).toEqual(sentences(m.dashboards.charts));
    expect([...DASHBOARD_COLUMNS].sort()).toEqual(sentences(m.dashboards.columns));
    expect([...DASHBOARD_EMPTY_REASONS].sort()).toEqual(sentences(m.dashboards.empty));
    expect([...DASHBOARD_HINTS].sort()).toEqual(sentences(m.dashboards.hints));
    expect([...DASHBOARD_SERIES].sort()).toEqual(sentences(m.dashboards.series));
    expect([...QUERY_GROUPS].sort()).toEqual(sentences(m.dashboards.query.groups));
    expect([...DASHBOARD_NOTES].sort()).toEqual(sentences(m.dashboards.query.notes));
    // Each metric has a title and a description.
    expect([...DASHBOARD_METRICS].sort()).toEqual(Object.keys(m.dashboards.metrics).sort());
    for (const metric of Object.values(m.dashboards.metrics)) {
      expect(Object.keys(metric).sort()).toEqual(['description', 'title']);
    }
  });

  it('explains every billing refusal and the plan limits', () => {
    // BillingError codes (@agile/billing) and the action's own fallback.
    for (const code of [
      'billing_disabled',
      'forbidden_role',
      'no_customer',
      'subscription_exists',
      'no_checkout_url',
      'stripe_error',
    ]) {
      expect(BILLING_ERROR_CODES).toContain(code);
    }
    expect(AUTH_ERROR_CODES).toContain('SEAT_LIMIT_REACHED');
    expect(typeof en.boards.errors.board_limit).toBe('string');
    expect(typeof fr.boards.errors.board_limit).toBe('string');
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
      'SIGN_UP_NOT_ALLOWED',
      'SSO_UNLINK_NOT_ALLOWED',
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
      BILLING_ERROR_CODES,
      BILLING_STATUSES,
      SETTINGS_ERROR_CODES,
      MCP_ERROR_CODES,
      LLM_ERROR_CODES,
      BOARD_ERROR_CODES,
      BLOCKED_REASONS,
      // (DASHBOARD_CODES has a real `blocked` code: no `blocked` group lives under it.)
      DASHBOARD_COLUMNS,
      DASHBOARD_EMPTY_REASONS,
      DASHBOARD_HINTS,
      DASHBOARD_METRICS,
      DASHBOARD_SERIES,
    ]) {
      expect(allowedCode(value, list)).toBeNull();
    }
  });
});
