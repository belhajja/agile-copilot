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
    expect((await call('GET', '/rest/api/2/user/search')).status).toBe(400);
    expect((await call('GET', '/rest/api/2/user/search?username=')).status).toBe(400);
    const viaJql = await call('GET', '/rest/api/2/search?jql=sprint%20%3D%204');
    const viaAgile = await call('GET', '/rest/agile/1.0/sprint/4/issue');
    const keys = (r: { body: Json }) => r.body.issues.map((i: { key: string }) => i.key).sort();
    expect(keys(viaJql)).toEqual([
      'DEMO-18',
      'DEMO-20',
      'DEMO-21',
      'DEMO-22',
      'DEMO-23',
      'DEMO-24',
      'DEMO-25',
    ]);
    expect(keys(viaAgile)).toEqual(keys(viaJql));
  });

  it('assigns by name on Data Center and reads it back', async () => {
    const before = jira.writes.length;
    expect((await call('PUT', '/rest/api/2/issue/DEMO-3/assignee', { name: 'sam' })).status).toBe(
      204,
    );
    expect((await call('GET', '/rest/api/2/issue/DEMO-3')).body.fields.assignee.name).toBe('sam');
    expect((await call('PUT', '/rest/api/2/issue/DEMO-3/assignee', { name: null })).status).toBe(
      204,
    );
    expect((await call('GET', '/rest/api/2/issue/DEMO-3')).body.fields.assignee).toBeNull();
    expect(
      (await call('PUT', '/rest/api/2/issue/DEMO-3/assignee', { accountId: 'u-sam' })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/rest/api/2/issue/DEMO-3/assignee', { name: 'nobody' })).status,
    ).toBe(404);
    expect(jira.writes.length).toBe(before + 2);
  });

  it('lists the system fields the agent edits, like Jira', async () => {
    // mcp-atlassian maps edit fields through /field and silently drops unknown ones.
    const fields = (await call('GET', '/rest/api/2/field')).body as { id: string }[];
    expect(fields.map((f) => f.id)).toEqual(
      expect.arrayContaining(['summary', 'description', 'labels', 'issuetype', 'assignee']),
    );
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
  });

  it('edits fields, refuses read-only ones and bumps updated', async () => {
    const before = jira.writes.length;
    const old = (await call('GET', '/rest/api/2/issue/DEMO-4')).body.fields.updated;
    expect(
      (await call('PUT', '/rest/api/2/issue/DEMO-4', { fields: { summary: 'Renamed' } })).status,
    ).toBe(204);
    const after = (await call('GET', '/rest/api/2/issue/DEMO-4')).body.fields;
    expect(after.summary).toBe('Renamed');
    expect(after.updated).not.toBe(old);
    for (const field of ['status', 'created', 'updated', 'id', 'key']) {
      expect(
        (await call('PUT', '/rest/api/2/issue/DEMO-4', { fields: { [field]: 'x' } })).status,
      ).toBe(400);
    }
    expect((await call('PUT', '/rest/api/2/issue/DEMO-4', { fields: 'nope' })).status).toBe(400);
    expect((await call('PUT', '/rest/api/2/issue/DEMO-4', [1])).status).toBe(400);
    // Extra, unknown top-level keys (e.g. `update`) are tolerated like Jira does.
    expect(
      (
        await call('PUT', '/rest/api/2/issue/DEMO-4', {
          fields: { __proto__: { polluted: true }, labels: ['a'] },
          update: {},
        })
      ).status,
    ).toBe(204);
    expect(({} as Json).polluted).toBeUndefined();
    expect(jira.writes.length).toBe(before + 2);
  });

  it('rejects invalid JSON, bad transitions and unknown projects without recording', async () => {
    const before = jira.writes.length;
    const raw = await fetch(`${jira.url}/rest/api/2/issue/DEMO-1/comment`, {
      method: 'POST',
      headers: { authorization: 'Bearer pat', 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ errorMessages: ['Invalid JSON'] });
    expect(
      (await call('POST', '/rest/api/2/issue/DEMO-1/transitions', { transition: { id: '999' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/rest/api/2/issue', {
          fields: { project: { key: 'NOPE' }, summary: 'x' },
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', '/rest/api/2/issue', { fields: 'x' })).status).toBe(400);
    expect(jira.writes.length).toBe(before);
  });

  it('does not record an unauthenticated write', async () => {
    const before = jira.writes.length;
    const res = await fetch(`${jira.url}/rest/api/2/issue/DEMO-1/comment`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(jira.writes.length).toBe(before);
  });

  it('a transition adds a status history entry and bumps updated', async () => {
    const t = (await call('GET', '/rest/api/2/issue/DEMO-5/transitions')).body.transitions;
    const done = t.find((x: { name: string }) => x.name === 'Done');
    await call('POST', '/rest/api/2/issue/DEMO-5/transitions', { transition: { id: done.id } });
    const issue = (await call('GET', '/rest/api/2/issue/DEMO-5')).body;
    const last = issue.changelog.histories.at(-1);
    expect(last.items[0]).toMatchObject({ field: 'status', fieldtype: 'jira', toString: 'Done' });
    expect(Date.parse(issue.fields.updated)).toBeGreaterThan(Date.parse('2026-10-03T00:00:00Z'));
  });

  it('refuses unknown issues and invalid writes', async () => {
    expect((await call('GET', '/rest/api/2/issue/NOPE-1')).status).toBe(404);
    expect((await call('POST', '/rest/api/2/issue/DEMO-1/comment', {})).status).toBe(400);
  });
});

describe('mock Jira: Cloud assignment', () => {
  it('assigns by accountId only', async () => {
    const jira = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer pat',
      dataset: demoDataset(new Date('2026-10-04T00:00:00Z')),
    });
    try {
      const put = (body: unknown) =>
        fetch(`${jira.url}/rest/api/3/issue/DEMO-3/assignee`, {
          method: 'PUT',
          headers: { authorization: 'Bearer pat', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await put({ accountId: 'u-kim' })).status).toBe(204);
      const issue: Json = await (
        await fetch(`${jira.url}/rest/api/3/issue/DEMO-3`, {
          headers: { authorization: 'Bearer pat' },
        })
      ).json();
      expect(issue.fields.assignee.accountId).toBe('u-kim');
      expect((await put({ name: 'kim' })).status).toBe(400);
      expect((await put({ accountId: 'u-none' })).status).toBe(404);
      expect((await put({ accountId: null })).status).toBe(204);
    } finally {
      await jira.close();
    }
  });
});

describe('mock Jira: user search', () => {
  it('serves extra users with their active flag and Cloud account type', async () => {
    const jira = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer pat',
      dataset: demoDataset(new Date('2026-10-04T00:00:00Z')),
      extraUsers: [
        { accountId: 'u-alex-old', name: 'alex.old', displayName: 'Alex Martin', active: false },
        { accountId: 'bot-1', name: 'bot', displayName: 'Release Bot', accountType: 'app' },
      ],
    });
    try {
      const search = async (query: string) =>
        (await (
          await fetch(`${jira.url}/rest/api/3/user/search?query=${encodeURIComponent(query)}`, {
            headers: { authorization: 'Bearer pat' },
          })
        ).json()) as Json[];
      expect(await search('alex martin')).toEqual([
        {
          accountId: 'u-alex',
          displayName: 'Alex Martin',
          active: true,
          accountType: 'atlassian',
        },
        {
          accountId: 'u-alex-old',
          displayName: 'Alex Martin',
          active: false,
          accountType: 'atlassian',
        },
      ]);
      expect(await search('release')).toEqual([
        { accountId: 'bot-1', displayName: 'Release Bot', active: true, accountType: 'app' },
      ]);
    } finally {
      await jira.close();
    }
  });
});

describe('mock Jira: assignable user search (mcp-atlassian jira_search_assignable_users)', () => {
  it('needs an issue or project, matches like user search and leaves out inactive users', async () => {
    const jira = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer pat',
      dataset: demoDataset(new Date('2026-10-04T00:00:00Z')),
      extraUsers: [
        { accountId: 'u-alex-old', name: 'alex.old', displayName: 'Alex Martin', active: false },
      ],
    });
    try {
      const get = async (search: string) => {
        const res = await fetch(`${jira.url}/rest/api/2/user/assignable/search?${search}`, {
          headers: { authorization: 'Bearer pat' },
        });
        return { status: res.status, body: (await res.json()) as Json };
      };
      expect(await get('username=alex%20martin&issueKey=DEMO-2')).toEqual({
        status: 200,
        body: [{ key: 'alex', name: 'alex', displayName: 'Alex Martin', active: true }],
      });
      expect((await get('username=sam&project=DEMO')).body).toMatchObject([{ name: 'sam' }]);
      expect((await get('username=alex')).status).toBe(400);
      expect((await get('username=alex&issueKey=NOPE-1')).status).toBe(404);
    } finally {
      await jira.close();
    }
  });
});
