import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoDataset, type MockJira, startMockJira } from './mock-jira-server';

// biome-ignore lint/suspicious/noExplicitAny: the tests read arbitrary Jira JSON.
type Json = any;

// The agent's Jira tools (and mcp-atlassian in the contract test) read issues and write to them.
describe('mock Jira: issue detail and writes', () => {
  let jira: MockJira;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(jira.url + path, {
      method,
      headers: { authorization: 'Bearer pat', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: Json = res.status === 204 ? null : await res.json();
    return { status: res.status, body: json };
  };
  beforeAll(async () => {
    jira = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer pat',
      pathPrefix: '/jira',
      dataset: demoDataset(new Date('2026-10-04T00:00:00Z')),
    });
  });
  afterAll(async () => jira?.close());

  it('records a comment and shows it on the issue', async () => {
    expect((await call('POST', '/rest/api/2/issue/DEMO-1/comment', { body: 'Hi' })).status).toBe(
      201,
    );
    const issue = await call('GET', '/rest/api/2/issue/DEMO-1?fields=summary,comment');
    expect(issue.body.fields.summary).toBe('Set up the release pipeline');
    expect(issue.body.fields.comment.comments).toMatchObject([{ body: 'Hi' }]);
    expect(jira.writes).toMatchObject([
      { method: 'POST', path: '/jira/rest/api/2/issue/DEMO-1/comment', body: { body: 'Hi' } },
    ]);
  });

  it('lists numeric transitions and applies one', async () => {
    const { body } = await call('GET', '/rest/api/2/issue/DEMO-2/transitions');
    const progress = body.transitions.find((t: { name: string }) => t.name === 'In Progress');
    expect(progress.id).toMatch(/^\d+$/);
    expect(
      (
        await call('POST', '/rest/api/2/issue/DEMO-2/transitions', {
          transition: { id: progress.id },
        })
      ).status,
    ).toBe(204);
    expect((await call('GET', '/rest/api/2/issue/DEMO-2')).body.fields.status.name).toBe(
      'In Progress',
    );
  });

  it('creates an issue that can be read back but is on no board', async () => {
    const created = await call('POST', '/rest/api/2/issue', {
      fields: { project: { key: 'DEMO' }, summary: 'Follow up', issuetype: { name: 'Task' } },
    });
    expect(created.status).toBe(201);
    expect((await call('GET', `/rest/api/2/issue/${created.body.key}`)).body.fields.summary).toBe(
      'Follow up',
    );
    expect(
      (await call('GET', '/rest/api/2/search?jql=filter%20%3D%20101')).body.issues.map(
        (i: { key: string }) => i.key,
      ),
    ).not.toContain(created.body.key);
  });

  it('finds users and the issues of a sprint', async () => {
    expect((await call('GET', '/rest/api/2/user/search?username=alex')).body).toMatchObject([
      { name: 'alex', displayName: 'Alex Martin' },
    ]);
    const sprint = await call('GET', '/rest/api/2/search?jql=sprint%20%3D%204');
    expect(sprint.body.issues.length).toBeGreaterThan(0);
  });

  it('refuses unknown issues and invalid writes', async () => {
    expect((await call('GET', '/rest/api/2/issue/NOPE-1')).status).toBe(404);
    expect((await call('POST', '/rest/api/2/issue/DEMO-1/comment', {})).status).toBe(400);
  });
});
