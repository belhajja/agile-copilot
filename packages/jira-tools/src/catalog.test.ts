import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isJiraMcpOnlyTool,
  isJiraToolName,
  isJiraWriteTool,
  JIRA_LOCAL_TOOLS,
  JIRA_MCP_ONLY_TOOLS,
  JIRA_TOOL_NAMES,
  JIRA_TOOLS,
  JIRA_WRITE_TOOLS,
  MCP_ISSUE_FIELDS,
  parseJiraToolInput,
} from './catalog';

describe('Jira tool allowlist', () => {
  it('exposes exactly the reviewed tools, writes flagged', () => {
    expect([...JIRA_TOOL_NAMES].sort()).toEqual([
      'jira_add_comment',
      'jira_assign_issue',
      'jira_create_issue',
      'jira_get_agile_boards',
      'jira_get_board_issues',
      'jira_get_cross_project_dependencies',
      'jira_get_issue',
      'jira_get_issue_dates',
      'jira_get_issue_watchers',
      'jira_get_link_types',
      'jira_get_project_components',
      'jira_get_project_epic_hierarchy',
      'jira_get_project_versions',
      'jira_get_sprint_issues',
      'jira_get_sprints_from_board',
      'jira_get_transitions',
      'jira_get_worklog',
      'jira_search',
      'jira_search_fields',
      'jira_transition_issue',
      'jira_update_issue',
      'jira_worklog_summary',
    ]);
    expect([...JIRA_WRITE_TOOLS].sort()).toEqual([
      'jira_add_comment',
      'jira_assign_issue',
      'jira_create_issue',
      'jira_transition_issue',
      'jira_update_issue',
    ]);
    for (const name of JIRA_TOOL_NAMES) expect(isJiraWriteTool(name)).toBe(JIRA_TOOLS[name].write);
    expect(isJiraWriteTool('jira_delete_issue')).toBe(false);
    expect(isJiraWriteTool('toString')).toBe(false);
    expect(isJiraToolName('jira_search')).toBe(true);
    expect(isJiraToolName('constructor')).toBe(false);
    expect(Object.isFrozen(JIRA_TOOL_NAMES)).toBe(true);
  });

  it.each([
    ['jira_add_comment', { issueKey: 'DEMO-1', body: 'x'.repeat(5001) }],
    ['jira_add_comment', { issueKey: 'demo-1; drop', body: 'hi' }],
    ['jira_get_sprints_from_board', { boardId: '../../admin' }],
    ['jira_update_issue', { issueKey: 'DEMO-1' }],
    ['jira_update_issue', { issueKey: 'DEMO-1', labels: ['has space'] }],
    ['jira_search', { jql: '', limit: 10 }],
    ['jira_transition_issue', { issueKey: 'DEMO-1', transitionId: 'Done' }],
    ['jira_transition_issue', { issueKey: 'DEMO-1', transitionId: '31; x' }],
    ['jira_update_issue', { issueKey: 'DEMO-1', labels: [] }],
  ] as const)('rejects bad %s input %o', (name, input) => {
    expect(parseJiraToolInput(name, input).success).toBe(false);
  });

  it('maps every tool to mcp-atlassian arguments and back', () => {
    const samples: { [N in keyof typeof JIRA_TOOLS]: unknown } = {
      jira_search: { jql: 'project = DEMO', limit: 5 },
      jira_get_issue: { issueKey: 'DEMO-1', commentLimit: 3 },
      jira_get_transitions: { issueKey: 'DEMO-1' },
      jira_get_agile_boards: { projectKey: 'DEMO' },
      jira_get_sprints_from_board: { boardId: '1', state: 'active' },
      jira_get_sprint_issues: { sprintId: '4', limit: 10 },
      jira_get_worklog: { issueKey: 'DEMO-1' },
      jira_worklog_summary: { jql: 'project = DEMO', from: '2026-10-01', to: '2026-10-09' },
      jira_get_board_issues: { boardId: '1', jql: 'status = Done', limit: 20 },
      jira_get_issue_dates: { issueKey: 'DEMO-1' },
      jira_get_project_epic_hierarchy: { projectKey: 'DEMO', maxEpics: 10 },
      jira_get_cross_project_dependencies: { projectKey: 'DEMO', maxIssues: 20 },
      jira_get_link_types: {},
      jira_get_project_versions: { projectKey: 'DEMO' },
      jira_get_project_components: { projectKey: 'DEMO' },
      jira_search_fields: { keyword: 'story points', limit: 10 },
      jira_get_issue_watchers: { issueKey: 'DEMO-1' },
      jira_add_comment: { issueKey: 'DEMO-1', body: 'Blocked by **API**' },
      jira_transition_issue: { issueKey: 'DEMO-1', transitionId: '31', comment: 'Done' },
      jira_assign_issue: { issueKey: 'DEMO-1', assignee: 'alex' },
      jira_create_issue: { projectKey: 'DEMO', summary: 'New', issueType: 'Task' },
      jira_update_issue: { issueKey: 'DEMO-1', summary: 'Renamed', labels: ['risk'] },
    };
    for (const name of JIRA_TOOL_NAMES) {
      const def = JIRA_TOOLS[name];
      const input = def.input.parse(samples[name]);
      const roundTrip = def.input.parse(
        (def.fromMcp as (a: Record<string, unknown>) => unknown)(
          (def.toMcp as (i: unknown) => Record<string, unknown>)(input),
        ),
      );
      expect({ name, roundTrip }).toEqual({ name, roundTrip: input });
    }
  });

  it('never lets the model name a tenant, connection or user', () => {
    // Tools are bound to the tenant on the server; no input may select an org, connection or user
    // account. (`assignee` names the Jira person to assign, which is the point of that tool.)
    for (const name of JIRA_TOOL_NAMES) {
      for (const prop of Object.keys(JIRA_TOOLS[name].input.shape)) {
        expect({ name, prop, tenantBound: !/org|connection|user|tenant/i.test(prop) }).toEqual({
          name,
          prop,
          tenantBound: true,
        });
      }
    }
  });

  it('is importable from the browser: the catalog depends on zod only', () => {
    const source = readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8');
    // `from '…'`, side-effect `import '…'`, dynamic `import('…')` and `require('…')`.
    const specifiers = (code: string) =>
      [
        ...code.matchAll(
          /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g,
        ),
      ].map((m) => m[1] ?? m[2] ?? m[3]);
    expect(
      specifiers(
        `import a from 'x';\nimport 'side';\nconst m = await import('dyn');\nrequire("req");`,
      ),
    ).toEqual(['x', 'side', 'dyn', 'req']);
    expect(specifiers(source)).toEqual(['zod']);
  });
});

describe('read tools for time tracking and delivery context', () => {
  const NEW_TOOLS = [
    'jira_get_worklog',
    'jira_worklog_summary',
    'jira_get_board_issues',
    'jira_get_issue_dates',
    'jira_get_project_epic_hierarchy',
    'jira_get_cross_project_dependencies',
    'jira_get_link_types',
    'jira_get_project_versions',
    'jira_get_project_components',
    'jira_search_fields',
    'jira_get_issue_watchers',
  ] as const;

  it('are all read-only', () => {
    for (const name of NEW_TOOLS)
      expect({ name, write: JIRA_TOOLS[name].write }).toEqual({ name, write: false });
  });

  it('marks the composite tools mcp-only and the summary local', () => {
    expect([...JIRA_MCP_ONLY_TOOLS].sort()).toEqual([
      'jira_get_cross_project_dependencies',
      'jira_get_issue_dates',
      'jira_get_project_epic_hierarchy',
      'jira_search_fields',
    ]);
    expect([...JIRA_LOCAL_TOOLS]).toEqual(['jira_worklog_summary']);
    expect(isJiraMcpOnlyTool('jira_search_fields')).toBe(true);
    expect(isJiraMcpOnlyTool('jira_get_worklog')).toBe(false);
  });

  it('asks mcp-atlassian for time tracking on issue reads', () => {
    expect(MCP_ISSUE_FIELDS.split(',')).toContain('timetracking');
    const issue = parseJiraToolInput('jira_get_issue', { issueKey: 'DEMO-1' });
    const search = parseJiraToolInput('jira_search', { jql: 'project = DEMO' });
    const sprint = parseJiraToolInput('jira_get_sprint_issues', { sprintId: '4' });
    if (!issue.success || !search.success || !sprint.success) throw new Error('invalid sample');
    expect(JIRA_TOOLS.jira_get_issue.toMcp(issue.data)).toMatchObject({ fields: MCP_ISSUE_FIELDS });
    expect(JIRA_TOOLS.jira_search.toMcp(search.data)).toMatchObject({ fields: MCP_ISSUE_FIELDS });
    expect(JIRA_TOOLS.jira_get_sprint_issues.toMcp(sprint.data)).toMatchObject({
      fields: MCP_ISSUE_FIELDS,
    });
  });

  it('bounds the inputs', () => {
    const bad = {
      jira_get_worklog: { issueKey: 'not a key' },
      jira_worklog_summary: { jql: 'project = DEMO', from: '2026-10-09', to: '2026-10-01' },
      jira_get_board_issues: { boardId: '1', limit: 51 },
      jira_get_project_epic_hierarchy: { projectKey: 'DEMO', maxEpics: 21 },
      jira_get_cross_project_dependencies: { projectKey: 'DEMO', maxIssues: 51 },
      jira_get_project_versions: { projectKey: 'demo' },
      jira_search_fields: { keyword: 'points', limit: 21 },
    } as const;
    for (const [name, input] of Object.entries(bad)) {
      expect({ name, ok: parseJiraToolInput(name as never, input).success }).toEqual({
        name,
        ok: false,
      });
    }
    expect(
      parseJiraToolInput('jira_worklog_summary', {
        jql: 'sprint in openSprints()',
        from: '2026-10-01',
        to: '2026-10-09',
      }).success,
    ).toBe(true);
    expect(
      parseJiraToolInput('jira_worklog_summary', { jql: 'x', from: '2026-13-01' }).success,
    ).toBe(false);
    expect(parseJiraToolInput('jira_get_link_types', {}).success).toBe(true);
  });

  it('round-trips every new mcp tool through toMcp and fromMcp', () => {
    const samples = {
      jira_get_worklog: { issueKey: 'DEMO-1' },
      jira_get_board_issues: { boardId: '1', jql: 'status = Done', limit: 20 },
      jira_get_issue_dates: { issueKey: 'DEMO-1' },
      jira_get_project_epic_hierarchy: { projectKey: 'DEMO', maxEpics: 10 },
      jira_get_cross_project_dependencies: { projectKey: 'DEMO', maxIssues: 20 },
      jira_get_link_types: {},
      jira_get_project_versions: { projectKey: 'DEMO' },
      jira_get_project_components: { projectKey: 'DEMO' },
      jira_search_fields: { keyword: 'story points', limit: 10 },
      jira_get_issue_watchers: { issueKey: 'DEMO-1' },
    } as const;
    for (const [name, input] of Object.entries(samples)) {
      const def = JIRA_TOOLS[name as keyof typeof samples];
      const parsed = def.input.parse(input);
      expect({
        name,
        back: def.input.parse(
          def.fromMcp((def.toMcp as (i: unknown) => Record<string, unknown>)(parsed)),
        ),
      }).toEqual({ name, back: parsed });
    }
  });
});
