import type { Actor } from '@agile/db';
import { describe, expect, it } from 'vitest';
import type { AgentDeps } from './deps';
import { buildJiraToolSet, type JiraSite, type JiraToolMode } from './tools';

const manager = { orgId: 'org', userId: 'u', roles: ['manager'] } as Actor;
const site = (id: string, authType: JiraSite['authType']): JiraSite => ({
  id,
  name: id,
  deployment: authType === 'pat' ? 'datacenter' : 'cloud',
  authType,
  usable: true,
});
const mode: JiraToolMode = { readOnly: true, mcpUrl: undefined };
const names = (sites: JiraSite[]) =>
  Object.keys(buildJiraToolSet({} as AgentDeps, manager, sites, mode));

describe('offering the Jira read tools', () => {
  it('offers the time tracking tools on every connection type', () => {
    expect(names([site('a', 'basic')])).toEqual(
      expect.arrayContaining(['jira_get_worklog', 'jira_worklog_summary']),
    );
    expect(names([site('a', 'pat')])).toEqual(
      expect.arrayContaining(['jira_get_worklog', 'jira_worklog_summary']),
    );
  });

  it('offers the mcp-only tools only when an mcp-atlassian site is usable', () => {
    expect(names([site('a', 'basic')])).not.toContain('jira_get_issue_dates');
    expect(names([site('a', 'pat')])).toContain('jira_get_issue_dates');
    expect(names([site('a', 'basic'), site('b', 'oauth')])).toContain('jira_search_fields');
  });

  it('limits the site choice of an mcp-only tool to mcp-atlassian sites', () => {
    const tools = buildJiraToolSet(
      {} as AgentDeps,
      manager,
      [site('a', 'basic'), site('b', 'pat')],
      mode,
    );
    const schema = tools.jira_get_issue_dates?.inputSchema as {
      safeParse(v: unknown): { success: boolean };
    };
    expect(schema.safeParse({ issueKey: 'DEMO-1', site: 'b' }).success).toBe(true);
    expect(schema.safeParse({ issueKey: 'DEMO-1', site: 'a' }).success).toBe(false);
  });

  it('keeps the from <= to check on a multi-site summary call', () => {
    const tools = buildJiraToolSet(
      {} as AgentDeps,
      manager,
      [site('a', 'basic'), site('b', 'pat')],
      mode,
    );
    const schema = tools.jira_worklog_summary?.inputSchema as {
      safeParse(v: unknown): { success: boolean };
    };
    expect(
      schema.safeParse({ jql: 'project = DEMO', from: '2026-10-02', to: '2026-10-01', site: 'a' })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ jql: 'project = DEMO', from: '2026-10-01', to: '2026-10-02', site: 'a' })
        .success,
    ).toBe(true);
  });

  it('gives viewers none of them', () => {
    const viewer = { ...manager, roles: ['viewer'] } as Actor;
    expect(
      Object.keys(buildJiraToolSet({} as AgentDeps, viewer, [site('a', 'pat')], mode)),
    ).toEqual([]);
  });
});
