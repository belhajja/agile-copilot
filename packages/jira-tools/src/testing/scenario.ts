import type { MockJira } from '@agile/jira/testing';
import type { JiraToolBackend } from '../backend';
import { type JiraToolName, parseJiraToolInput } from '../catalog';

// One scenario shared by the backend tests: reads, then every kind of write (each exactly once).
// The assignee is an exact display name: backends never assign on a fuzzy match.
export const ANCHOR = new Date('2026-10-04T00:00:00Z');
export const outbound = { allowedPrivateHosts: ['127.0.0.1'] };
export const run = <N extends JiraToolName>(b: JiraToolBackend, name: N, input: unknown) => {
  const parsed = parseJiraToolInput(name, input);
  if (!parsed.success) throw new Error(`bad input for ${name}`);
  return b.call(name, parsed.data);
};

/** The same scenario against any backend: reads work, every write reaches Jira exactly once. */
export async function exercise(backend: JiraToolBackend, jira: MockJira) {
  jira.writes.length = 0;
  const found = (await run(backend, 'jira_search', { jql: 'filter = 101', limit: 3 })) as {
    issues: { key: string }[];
  };
  const issue = (await run(backend, 'jira_get_issue', { issueKey: 'DEMO-1' })) as {
    summary?: string;
  };
  const transitions = (await run(backend, 'jira_get_transitions', { issueKey: 'DEMO-1' })) as {
    transitions: { id: string; name: string }[];
  };
  await run(backend, 'jira_add_comment', { issueKey: 'DEMO-1', body: 'Blocked by the API team' });
  await run(backend, 'jira_transition_issue', {
    issueKey: 'DEMO-2',
    transitionId: transitions.transitions.find((t) => t.name === 'In Progress')?.id,
  });
  const assigned = await run(backend, 'jira_assign_issue', {
    issueKey: 'DEMO-2',
    assignee: 'Alex Martin',
  });
  await run(backend, 'jira_create_issue', {
    projectKey: 'DEMO',
    summary: 'Follow up',
    issueType: 'Task',
  });
  await run(backend, 'jira_update_issue', { issueKey: 'DEMO-3', labels: ['risk'] });
  return {
    found,
    issue,
    transitions,
    assigned,
    writes: jira.writes.map((w) => `${w.method} ${w.path}`),
  };
}

export const EXPECTED_WRITES = [
  'POST /rest/api/2/issue/DEMO-1/comment',
  'POST /rest/api/2/issue/DEMO-2/transitions',
  'PUT /rest/api/2/issue/DEMO-2/assignee',
  'POST /rest/api/2/issue',
  'PUT /rest/api/2/issue/DEMO-3',
];
