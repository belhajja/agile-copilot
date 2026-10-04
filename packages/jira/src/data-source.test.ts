import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { completeHistories, createJiraDataSource, type JiraDataSource } from './data-source';
import { buildIssueJql, issueFieldList, normalizeIssue } from './issue-normalize';
import type { RawChangelogHistory, RawIssue } from './sync-types';
import {
  DEMO_SPRINT_FIELD,
  demoDataset,
  type MockJira,
  startMockJira,
} from './testing/mock-jira-server';
import type { JiraCredentials } from './types';

const anchor = new Date('2026-10-04T00:00:00Z');
const now = new Date('2026-10-04T08:00:00Z');
const dataset = demoDataset(anchor);
const noWait = { sleep: async () => {} };

// The same contract runs against both flavours of the mock: Cloud (jira.js v6, REST v3,
// nextPageToken search) and Data Center (jira.js v5, REST v2, startAt search).
const flavours = [
  {
    flavor: 'cloud' as const,
    auth: `Basic ${Buffer.from('pm@acme.com:tok').toString('base64')}`,
    creds: (url: string): JiraCredentials => ({
      kind: 'cloud_basic',
      baseUrl: url,
      email: 'pm@acme.com',
      apiToken: 'tok',
    }),
  },
  {
    flavor: 'datacenter' as const,
    auth: 'Bearer good-pat',
    creds: (url: string): JiraCredentials => ({
      kind: 'datacenter_pat',
      baseUrl: url,
      token: 'good-pat',
    }),
  },
];

describe.each(flavours)('Jira data source contract ($flavor)', ({ flavor, auth, creds }) => {
  let mock: MockJira | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  const start = async (extra: Partial<Parameters<typeof startMockJira>[0]> = {}) => {
    mock = await startMockJira({
      flavor,
      validAuthorization: auth,
      pathPrefix: flavor === 'datacenter' ? '/jira' : '',
      dataset,
      now: () => now,
      ...extra,
    });
    return createJiraDataSource(creds(mock.url), { retry: noWait, pageSize: 10 });
  };

  it('lists boards, their configuration and sprints', async () => {
    const source = await start({ maxPageSize: 1 }); // forces board/sprint pagination
    expect(await source.listBoards()).toEqual([
      { jiraBoardId: 1, name: 'DEMO Scrum', type: 'scrum', projectKey: 'DEMO' },
      { jiraBoardId: 2, name: 'OPS Kanban', type: 'kanban', projectKey: 'OPS' },
    ]);
    expect(await source.getBoardConfig(1)).toEqual({
      filterId: 101,
      estimationFieldId: 'customfield_10016',
      estimationFieldName: 'Story Points',
      columns: [
        { name: 'To Do', statusIds: ['10000'] },
        { name: 'In Progress', statusIds: ['3', '10002'] },
        { name: 'In Review', statusIds: ['10001'] },
        { name: 'Done', statusIds: ['10003'] },
      ],
    });
    expect((await source.getBoardConfig(2)).estimationFieldId).toBeNull();
    const sprints = await source.listSprints(1);
    expect(sprints.map((s) => [s.jiraSprintId, s.state])).toEqual([
      [1, 'closed'],
      [2, 'closed'],
      [3, 'closed'],
      [4, 'active'],
    ]);
    expect(sprints[0]?.startAt).toEqual(new Date('2026-08-16T10:00:00Z'));
  });

  it('lists statuses with categories and finds the sprint field', async () => {
    const source = await start();
    expect((await source.listStatuses()).map((s) => [s.name, s.categoryKey])).toEqual([
      ['To Do', 'new'],
      ['In Progress', 'indeterminate'],
      ['In Review', 'indeterminate'],
      ['Blocked', 'indeterminate'],
      ['Done', 'done'],
    ]);
    expect((await source.listFields()).find((f) => f.id === DEMO_SPRINT_FIELD)?.custom).toBe(
      'com.pyxis.greenhopper.jira:gh-sprint',
    );
  });

  it('pages through a board search and completes truncated changelogs', async () => {
    const source = await start({ searchChangelogLimit: 1 });
    const ctx = {
      estimationFieldId: 'customfield_10016',
      estimationFieldName: 'Story Points',
      sprintFieldId: DEMO_SPRINT_FIELD,
    };
    const keys: string[] = [];
    let pages = 0;
    let transitions = 0;
    for await (const page of source.searchIssues(
      buildIssueJql(101, null, now),
      issueFieldList(ctx),
    )) {
      pages++;
      for (const issue of page) {
        keys.push(issue.key);
        const n = normalizeIssue(issue, await completeHistories(source, issue), ctx);
        transitions += n.transitions.length;
      }
    }
    const demo = dataset.issues.filter((i) => i.filterIds.includes(101));
    expect(keys).toHaveLength(demo.length); // 25 issues
    expect(pages).toBe(3); // 10 + 10 + 5
    expect(new Set(keys).size).toBe(keys.length);
    const expected = demo.reduce(
      (n, i) => n + i.histories.filter((h) => h.items[0]?.field === 'status').length,
      0,
    );
    expect(transitions).toBe(expected); // nothing lost to the truncated search changelog
  });

  it('only returns issues updated inside an incremental window', async () => {
    const source = await start();
    const since = new Date(now.getTime() - 3 * 86_400_000);
    const keys: string[] = [];
    for await (const page of source.searchIssues(buildIssueJql(102, since, now), ['summary'])) {
      keys.push(...page.map((i) => i.key));
    }
    const cutoff = since.getTime() - 15 * 60_000;
    const expected = dataset.issues
      .filter((i) => i.filterIds.includes(102))
      .filter((i) => Date.parse(String(i.fields.updated).replace('+0000', 'Z')) >= cutoff)
      .map((i) => i.key);
    expect(keys.sort()).toEqual(expected.sort());
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(31);
  });

  it('waits out 429 responses (Retry-After) and carries on', async () => {
    const waited: number[] = [];
    mock = await startMockJira({
      flavor,
      validAuthorization: auth,
      dataset,
      rateLimitFirst: 2,
      retryAfterSeconds: 3,
    });
    const source = createJiraDataSource(creds(mock.url), {
      retry: { sleep: async (ms) => void waited.push(ms) },
    });
    expect(await source.listBoards()).toHaveLength(2);
    expect(waited).toEqual([3_000, 3_000]);
  });

  it('gives up on a persistent 429 after the bounded number of retries', async () => {
    const waited: number[] = [];
    mock = await startMockJira({
      flavor,
      validAuthorization: auth,
      dataset,
      rateLimitFirst: 1000,
      retryAfterSeconds: 1,
    });
    const source = createJiraDataSource(creds(mock.url), {
      retry: { maxRetries: 2, sleep: async (ms) => void waited.push(ms) },
    });
    await expect(source.listBoards()).rejects.toMatchObject({ status: 429 });
    expect(waited).toEqual([1_000, 1_000]);
    expect(mock.requests).toHaveLength(3);
  });

  it('completes a 130-history issue the search truncated at 100', async () => {
    const long = longHistoryDataset();
    mock = await startMockJira({
      flavor,
      validAuthorization: auth,
      pathPrefix: flavor === 'datacenter' ? '/jira' : '',
      dataset: long,
      now: () => now,
    });
    const source = createJiraDataSource(creds(mock.url), { retry: noWait });
    const ctx = {
      estimationFieldId: null,
      estimationFieldName: null,
      sprintFieldId: DEMO_SPRINT_FIELD,
    };
    const issues: RawIssue[] = [];
    for await (const page of source.searchIssues(buildIssueJql(101, null, now), ['status'])) {
      issues.push(...page);
    }
    const issue = issues.find((i) => i.key === 'LONG-1');
    expect(issue?.changelog?.histories).toHaveLength(100);
    expect(issue?.changelog?.total).toBe(130);
    const histories = await completeHistories(source, issue as RawIssue);
    expect(histories).toHaveLength(130);
    expect(normalizeIssue(issue as RawIssue, histories, ctx).transitions).toHaveLength(130);
  });

  it('refuses to follow redirects', async () => {
    const hits: string[] = [];
    const target: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"values":[]}');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const redirector: Server = createServer((_req, res) => {
      res
        .writeHead(302, {
          location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`,
        })
        .end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      const source = createJiraDataSource(
        creds(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}`),
        {
          retry: noWait,
        },
      );
      await expect(source.listBoards()).rejects.toMatchObject({ status: 302 });
      expect(hits).toEqual([]);
    } finally {
      for (const s of [target, redirector]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
    }
  });
});

function longHistoryDataset() {
  const base = demoDataset(anchor);
  const item = (i: number) => ({
    field: 'status',
    fieldId: 'status',
    fieldtype: 'jira',
    from: i % 2 ? '10000' : '3',
    fromString: null,
    to: i % 2 ? '3' : '10000',
    toString: null,
  });
  const histories = Array.from({ length: 130 }, (_, i) => ({
    id: String(900_000 + i),
    created: new Date(anchor.getTime() - (200 - i) * 3_600_000).toISOString().replace('Z', '+0000'),
    items: [item(i)],
  }));
  return {
    ...base,
    issues: [
      ...base.issues,
      {
        id: '99001',
        key: 'LONG-1',
        filterIds: [101],
        fields: {
          summary: 'Long history',
          issuetype: { name: 'Story', subtask: false },
          status: { id: '10000', name: 'To Do' },
          created: new Date(anchor.getTime() - 300 * 3_600_000).toISOString().replace('Z', '+0000'),
          updated: new Date(anchor.getTime() - 3_600_000).toISOString().replace('Z', '+0000'),
        },
        histories,
      },
    ],
  };
}

const stubSource = (full: RawChangelogHistory[]) => {
  const calls: string[] = [];
  const source = {
    getFullChangelog: async (key: string) => {
      calls.push(key);
      return full;
    },
  } as unknown as JiraDataSource;
  return { source, calls };
};
const hist = (n: number): RawChangelogHistory[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    created: '2026-01-01T00:00:00.000+0000',
    items: [],
  }));
const issueWith = (changelog: RawIssue['changelog']): RawIssue => ({
  id: '1',
  key: 'A-1',
  fields: {},
  changelog,
});

describe('completeHistories', () => {
  it('trusts a complete inline changelog', async () => {
    const { source, calls } = stubSource([]);
    const inline = hist(3);
    expect(await completeHistories(source, issueWith({ total: 3, histories: inline }))).toBe(
      inline,
    );
    expect(await completeHistories(source, issueWith({ histories: inline }))).toBe(inline);
    expect(calls).toEqual([]);
  });

  it('fetches the rest when histories.length < total', async () => {
    const full = hist(130);
    const { source, calls } = stubSource(full);
    expect(await completeHistories(source, issueWith({ total: 130, histories: hist(100) }))).toBe(
      full,
    );
    expect(calls).toEqual(['A-1']);
  });

  it('does not treat a missing total as complete at exactly 100 histories', async () => {
    const full = hist(130);
    const { source, calls } = stubSource(full);
    expect(await completeHistories(source, issueWith({ histories: hist(100) }))).toBe(full);
    expect(calls).toEqual(['A-1']);
  });

  it('fetches when the issue carries no changelog at all', async () => {
    const full = hist(2);
    const { source } = stubSource(full);
    expect(await completeHistories(source, issueWith(undefined))).toBe(full);
  });
});

describe('Jira data source (credentials provider)', () => {
  it('asks the provider for fresh credentials on every request', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-2',
      pathPrefix: '/ex/jira/cloud-123',
      dataset,
    });
    try {
      let n = 0;
      const source = createJiraDataSource(
        async (): Promise<JiraCredentials> => ({
          kind: 'cloud_oauth',
          baseUrl: 'https://acme.atlassian.net',
          cloudId: 'cloud-123',
          accessToken: ++n <= 2 ? 'stale' : 'access-2',
        }),
        { atlassianApiBase: new URL(mock.url).origin, retry: noWait },
      );
      await expect(source.listBoards()).rejects.toMatchObject({ status: 401 });
      expect(await source.listBoards()).toHaveLength(2);
      expect(mock.requests.map((r) => r.authorization)).toEqual([
        'Bearer stale',
        'Bearer access-2',
      ]);
    } finally {
      await mock.close();
    }
  });
});

describe('Jira data source (Cloud OAuth gateway)', () => {
  it('routes through api.atlassian.com/ex/jira/{cloudId} with a bearer token', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-1',
      pathPrefix: '/ex/jira/cloud-123',
      dataset,
    });
    try {
      const source = createJiraDataSource(
        {
          kind: 'cloud_oauth',
          baseUrl: 'https://acme.atlassian.net',
          cloudId: 'cloud-123',
          accessToken: 'access-1',
        },
        { atlassianApiBase: new URL(mock.url).origin, retry: noWait },
      );
      expect(await source.listBoards()).toHaveLength(2);
      expect(mock.requests.every((r) => r.path.startsWith('/ex/jira/cloud-123/'))).toBe(true);
    } finally {
      await mock.close();
    }
  });
});
