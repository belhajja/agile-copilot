import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isJiraToolName,
  isJiraWriteTool,
  JIRA_TOOL_NAMES,
  JIRA_TOOLS,
  JIRA_WRITE_TOOLS,
  parseJiraToolInput,
} from './catalog';

describe('Jira tool allowlist', () => {
  it('exposes exactly the reviewed tools, writes flagged', () => {
    expect([...JIRA_TOOL_NAMES].sort()).toEqual([
      'jira_add_comment',
      'jira_assign_issue',
      'jira_create_issue',
      'jira_get_agile_boards',
      'jira_get_issue',
      'jira_get_sprint_issues',
      'jira_get_sprints_from_board',
      'jira_get_transitions',
      'jira_search',
      'jira_transition_issue',
      'jira_update_issue',
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
