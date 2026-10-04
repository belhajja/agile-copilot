import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { demoDataset, type MockJira, startMockJira } from '@agile/jira/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JiraToolError } from './backend';
import { createRestJiraBackend } from './rest-backend';
import { ANCHOR, EXPECTED_WRITES, exercise, outbound, run } from './testing/scenario';

const CLOUD_AUTH = `Basic ${Buffer.from('pm@acme.com:tok').toString('base64')}`;

describe('REST Jira backend (Cloud API tokens) against the mock Jira', () => {
  let cloud: MockJira;
  beforeAll(async () => {
    cloud = await startMockJira({
      flavor: 'cloud',
      validAuthorization: CLOUD_AUTH,
      dataset: demoDataset(ANCHOR),
    });
  });
  afterAll(async () => cloud?.close());
  const backend = () =>
    createRestJiraBackend(
      { kind: 'cloud_basic', baseUrl: cloud.url, email: 'pm@acme.com', apiToken: 'tok' },
      { outbound },
    );

  it('REST backend (Cloud API token) runs the reads and the writes', async () => {
    const r = await exercise(backend(), cloud);
    expect(r.found.issues.map((i) => i.key)).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3']);
    expect(r.issue.summary).toBe('Set up the release pipeline');
    expect(r.writes).toEqual(EXPECTED_WRITES);
    expect(cloud.writes[0]?.body).toEqual({
      body: 'Blocked by the *API* team:\n* {{npm ci}} fails',
    });
    // Cloud identifies the assignee by accountId.
    expect(cloud.writes[2]?.body).toEqual({ accountId: 'u-alex' });
    expect(cloud.writes.every((w) => w.authorization === CLOUD_AUTH)).toBe(true);
  });

  it('assigns only an exact, active person on Cloud and lists candidates otherwise', async () => {
    const jira = await startMockJira({
      flavor: 'cloud',
      validAuthorization: CLOUD_AUTH,
      dataset: demoDataset(ANCHOR),
      extraUsers: [
        { accountId: 'u-alex-old', name: 'alex.old', displayName: 'Alex Martin', active: false },
        { accountId: 'bot-1', name: 'bot', displayName: 'Release Bot', accountType: 'app' },
        ...[1, 2, 3, 4, 5, 6].map((i) => ({
          accountId: `u-ann-${i}`,
          name: `ann${i}`,
          displayName: `Ann ${i}`,
        })),
      ],
    });
    try {
      const b = createRestJiraBackend(
        { kind: 'cloud_basic', baseUrl: jira.url, email: 'pm@acme.com', apiToken: 'tok' },
        { outbound },
      );
      const assign = (assignee: string) =>
        run(b, 'jira_assign_issue', { issueKey: 'DEMO-3', assignee });
      // The deactivated "Alex Martin" is ignored; the exact active one is resolved.
      await expect(assign('alex martin')).resolves.toEqual({
        ok: true,
        issueKey: 'DEMO-3',
        assignee: { id: 'u-alex', displayName: 'Alex Martin' },
      });
      await expect(assign('u-kim')).resolves.toMatchObject({
        assignee: { id: 'u-kim', displayName: 'Kim Dubois' },
      });
      expect(jira.writes.map((w) => w.body)).toEqual([
        { accountId: 'u-alex' },
        { accountId: 'u-kim' },
      ]);

      // A single fuzzy hit is not enough: the user approved "ale", not "Alex Martin".
      const fuzzy = await assign('ale').catch((e: unknown) => e);
      expect(fuzzy).toBeInstanceOf(JiraToolError);
      expect(fuzzy).toMatchObject({
        code: 'ambiguous_user',
        message: 'Jira tool failed: ambiguous_user',
        candidates: [{ id: 'u-alex', displayName: 'Alex Martin' }],
      });
      expect((fuzzy as JiraToolError).toData()).toEqual({
        error: 'ambiguous_user',
        candidates: [{ id: 'u-alex', displayName: 'Alex Martin' }],
      });
      // "m" matches Alex Martin, Sam Leroy and Kim Dubois, none exactly; never more than 5, no emails.
      const many = (await assign('m').catch((e: unknown) => e)) as JiraToolError;
      expect(many.code).toBe('ambiguous_user');
      expect([...(many.candidates ?? [])].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'u-alex', displayName: 'Alex Martin' },
        { id: 'u-kim', displayName: 'Kim Dubois' },
        { id: 'u-sam', displayName: 'Sam Leroy' },
      ]);
      expect(
        ((await assign('ann').catch((e: unknown) => e)) as JiraToolError).candidates,
      ).toHaveLength(5);
      // App accounts are not people; unknown people are not found.
      await expect(assign('Release Bot')).rejects.toMatchObject({ code: 'not_found' });
      const unknown = await assign('nobody').catch((e: unknown) => e);
      expect(unknown).toMatchObject({ code: 'not_found' });
      expect((unknown as JiraToolError).toData()).toEqual({ error: 'not_found' });
      expect(jira.writes).toHaveLength(2);
    } finally {
      await jira.close();
    }
  });

  it('reports more results on Cloud without inventing a total', async () => {
    const page = (await run(backend(), 'jira_search', { jql: 'filter = 101', limit: 1 })) as {
      total: number | null;
      hasMore: boolean;
      issues: { key: string }[];
    };
    expect(page).toMatchObject({ total: null, hasMore: true });
    expect(page.issues.map((i) => i.key)).toEqual(['DEMO-1']);
  });

  it('reads boards, sprints and sprint issues through the agile API', async () => {
    const b = backend();
    const boards = (await run(b, 'jira_get_agile_boards', { projectKey: 'DEMO' })) as {
      boards: { id: unknown; name: string | null; type: string | null }[];
    };
    expect(boards.boards).toContainEqual({ id: 1, name: 'DEMO Scrum', type: 'scrum' });
    expect(cloud.requests.at(-1)?.search).toContain('projectKeyOrId=DEMO');

    const sprints = (await run(b, 'jira_get_sprints_from_board', {
      boardId: '1',
      state: 'active',
    })) as { sprints: { id: unknown; name: string | null; state: string | null }[] };
    expect(cloud.requests.at(-1)?.path).toBe('/rest/agile/1.0/board/1/sprint');
    expect(cloud.requests.at(-1)?.search).toContain('state=active');
    expect(sprints.sprints).toContainEqual(
      expect.objectContaining({
        id: 4,
        name: 'DEMO Sprint 4',
        state: 'active',
        goal: 'Sprint 4 goal',
      }),
    );

    const inSprint = (await run(b, 'jira_get_sprint_issues', { sprintId: '4', limit: 50 })) as {
      total: number;
      issues: { key: string | null; status: string | null }[];
    };
    expect(cloud.requests.at(-1)?.path).toBe('/rest/agile/1.0/sprint/4/issue');
    expect(inSprint.issues.length).toBeGreaterThan(0);
    expect(inSprint.total).toBe(inSprint.issues.length);
    expect(inSprint.issues.every((i) => i.key?.startsWith('DEMO-') && i.status)).toBe(true);
  });

  it('maps Jira errors to codes', async () => {
    await expect(run(backend(), 'jira_get_issue', { issueKey: 'NOPE-1' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const wrong = createRestJiraBackend(
      { kind: 'cloud_basic', baseUrl: cloud.url, email: 'pm@acme.com', apiToken: 'bad' },
      { outbound },
    );
    await expect(run(wrong, 'jira_get_issue', { issueKey: 'DEMO-1' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('REST backend refuses private hosts that are not allowlisted', async () => {
    const backend = createRestJiraBackend(
      { kind: 'cloud_basic', baseUrl: cloud.url, email: 'pm@acme.com', apiToken: 'tok' },
      { outbound: { allowedPrivateHosts: [] } },
    );
    await expect(run(backend, 'jira_get_issue', { issueKey: 'DEMO-1' })).rejects.toMatchObject({
      code: 'blocked_url',
    });
  });
});

describe('REST Jira backend (Data Center PAT) against the mock Jira', () => {
  let dc: MockJira;
  beforeAll(async () => {
    dc = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer good-pat',
      dataset: demoDataset(ANCHOR),
    });
  });
  afterAll(async () => dc?.close());
  const backend = () =>
    createRestJiraBackend(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
      {
        outbound,
      },
    );

  it('runs the same scenario, assigning by username', async () => {
    const r = await exercise(backend(), dc);
    expect(r.found.issues.map((i) => i.key)).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3']);
    expect(r.writes).toEqual(EXPECTED_WRITES);
    expect(dc.writes[2]?.body).toEqual({ name: 'alex' });
    expect(dc.writes.every((w) => w.authorization === 'Bearer good-pat')).toBe(true);
  });

  it('posts Markdown as Jira wiki markup, like mcp-atlassian (comments, descriptions)', async () => {
    dc.writes.length = 0;
    const md = '**Risk:** see `npm ci`\n- one';
    const wiki = '*Risk:* see {{npm ci}}\n* one';
    await run(backend(), 'jira_add_comment', { issueKey: 'DEMO-1', body: md });
    await run(backend(), 'jira_transition_issue', {
      issueKey: 'DEMO-2',
      transitionId: '21',
      comment: md,
    });
    await run(backend(), 'jira_create_issue', {
      projectKey: 'DEMO',
      summary: '**Not** converted',
      issueType: 'Task',
      description: md,
    });
    await run(backend(), 'jira_update_issue', {
      issueKey: 'DEMO-3',
      summary: '**Not** converted',
      description: md,
    });
    expect(dc.writes.map((w) => w.body)).toEqual([
      { body: wiki },
      { transition: { id: '21' }, update: { comment: [{ add: { body: wiki } }] } },
      {
        fields: {
          project: { key: 'DEMO' },
          summary: '**Not** converted',
          issuetype: { name: 'Task' },
          description: wiki,
        },
      },
      { fields: { summary: '**Not** converted', description: wiki } },
    ]);
  });

  it('assigns only an exact username on Data Center', async () => {
    dc.writes.length = 0;
    await expect(
      run(backend(), 'jira_assign_issue', { issueKey: 'DEMO-3', assignee: 'm' }),
    ).rejects.toMatchObject({
      code: 'ambiguous_user',
      candidates: [
        { id: 'alex', displayName: 'Alex Martin' },
        { id: 'sam', displayName: 'Sam Leroy' },
        { id: 'kim', displayName: 'Kim Dubois' },
      ],
    });
    await expect(
      run(backend(), 'jira_assign_issue', { issueKey: 'DEMO-3', assignee: 'sa' }),
    ).rejects.toMatchObject({ code: 'ambiguous_user', candidates: [{ id: 'sam' }] });
    await expect(
      run(backend(), 'jira_assign_issue', { issueKey: 'DEMO-3', assignee: 'sam' }),
    ).resolves.toEqual({
      ok: true,
      issueKey: 'DEMO-3',
      assignee: { id: 'sam', displayName: 'Sam Leroy' },
    });
    expect(dc.writes.map((w) => w.body)).toEqual([{ name: 'sam' }]);
  });

  it("keeps Jira's total on Data Center", async () => {
    const page = (await run(backend(), 'jira_search', { jql: 'filter = 101', limit: 1 })) as {
      total: number | null;
      hasMore: boolean;
    };
    expect(page.total).toBeGreaterThan(1);
    expect(page.hasMore).toBe(true);
  });

  it('reads boards, sprints and sprint issues', async () => {
    const b = backend();
    expect(
      ((await run(b, 'jira_get_agile_boards', {})) as { boards: unknown[] }).boards,
    ).toContainEqual({ id: 2, name: 'OPS Kanban', type: 'kanban' });
    const sprints = (await run(b, 'jira_get_sprints_from_board', { boardId: '1' })) as {
      sprints: { id: unknown }[];
    };
    expect(sprints.sprints.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    const inSprint = (await run(b, 'jira_get_sprint_issues', { sprintId: '4' })) as {
      issues: { key: string | null }[];
    };
    expect(inSprint.issues.length).toBeGreaterThan(0);
  });
});

describe('REST Jira backend response cap', () => {
  it('stops reading a body larger than 5 MB while it streams', async () => {
    const TOTAL = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    let closed!: () => void;
    const done = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((_req, res) => {
      // Chunked, no Content-Length: only a streaming byte count can catch it.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => closed());
      const pump = () => {
        while (sent < TOTAL) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const backend = createRestJiraBackend(
        { kind: 'datacenter_pat', baseUrl: `http://127.0.0.1:${port}`, token: 'pat' },
        { outbound },
      );
      await expect(run(backend, 'jira_get_issue', { issueKey: 'DEMO-1' })).rejects.toMatchObject({
        code: 'jira_error',
      });
      await done;
      expect(sent).toBeLessThan(TOTAL);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
