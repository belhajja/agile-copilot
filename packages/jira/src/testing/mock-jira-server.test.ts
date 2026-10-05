import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_SPRINT_FIELD,
  demoDataset,
  type MockJira,
  type MockJiraDataset,
  startMockJira,
} from './mock-jira-server';

const ANCHOR = new Date('2026-10-04T15:30:00Z');
const AUTH = 'Bearer t';
const servers: MockJira[] = [];

async function start(
  flavor: 'cloud' | 'datacenter',
  extra: Partial<Parameters<typeof startMockJira>[0]> = {},
  dataset: MockJiraDataset = demoDataset(ANCHOR),
) {
  const mock = await startMockJira({
    flavor,
    validAuthorization: AUTH,
    dataset,
    now: () => ANCHOR,
    ...extra,
  });
  servers.push(mock);
  const get = async (path: string) => {
    const res = await fetch(`${mock.url}${path}`, { headers: { authorization: AUTH } });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { mock, get };
}
const jql = (s: string) => `jql=${encodeURIComponent(s)}`;
const searchPath = (flavor: 'cloud' | 'datacenter') =>
  flavor === 'cloud' ? '/rest/api/3/search/jql' : '/rest/api/2/search';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe.each(['cloud', 'datacenter'] as const)('mock Jira (%s)', (flavor) => {
  const api = flavor === 'cloud' ? '3' : '2';

  it('answers 429 with Retry-After on data endpoints only, then recovers', async () => {
    const { get } = await start(flavor, { rateLimitFirst: 2, retryAfterSeconds: 7 });
    expect((await get(`/rest/api/${api}/myself`)).status).toBe(200);
    for (let n = 0; n < 2; n++) {
      const r = await get('/rest/agile/1.0/board');
      expect([r.status, r.headers.get('retry-after')]).toEqual([429, '7']);
    }
    expect((await get('/rest/agile/1.0/board')).status).toBe(200);
  });

  it('clamps page size to maxPageSize', async () => {
    const { get } = await start(flavor, { maxPageSize: 3 });
    const r = await get(`${searchPath(flavor)}?${jql('filter = 101')}&maxResults=100`);
    expect(r.body.issues).toHaveLength(3);
  });

  it('rejects unsupported JQL and the sprints of a Kanban board', async () => {
    const { get } = await start(flavor);
    expect((await get(`${searchPath(flavor)}?${jql('project = DEMO')}`)).status).toBe(400);
    expect((await get('/rest/agile/1.0/board/2/sprint')).status).toBe(400);
    expect((await get('/rest/agile/1.0/board/1/sprint')).body.values).toHaveLength(4);
  });

  it("serves a quoted project key, newest first, as mcp-atlassian's own tools query it", async () => {
    const { get } = await start(flavor);
    const r = await get(`${searchPath(flavor)}?${jql('project = "DEMO" ORDER BY updated DESC')}`);
    expect(r.body.issues.length).toBeGreaterThan(0);
    expect(r.body.issues.every((i: { key: string }) => i.key.startsWith('DEMO-'))).toBe(true);
    const updated = r.body.issues.map((i: { fields: { updated: string } }) => i.fields.updated);
    expect(updated).toEqual([...updated].sort().reverse());
    // No epic in the demo data: a legitimate empty result, not an error.
    const epics = await get(
      `${searchPath(flavor)}?${jql('project = "DEMO" AND issuetype = Epic ORDER BY updated DESC')}`,
    );
    expect(epics.body.issues).toEqual([]);
  });

  it('filters by the relative updated window', async () => {
    const { get } = await start(flavor, { maxPageSize: 200 });
    const all = await get(`${searchPath(flavor)}?${jql('filter = 102')}`);
    const recent = await get(
      `${searchPath(flavor)}?${jql('filter = 102 AND updated >= "-4320m"')}`,
    );
    const count = (r: { body: { issues: unknown[] } }) => r.body.issues.length;
    expect(count(all)).toBe(31);
    expect(count(recent)).toBeGreaterThan(0);
    expect(count(recent)).toBeLessThan(31);
  });

  it('serves statusCategory on issue statuses', async () => {
    const { get } = await start(flavor);
    const r = await get(`${searchPath(flavor)}?${jql('filter = 101')}`);
    const statuses = r.body.issues.map(
      (i: { fields: { status: { id: string; statusCategory: unknown } } }) => i.fields.status,
    );
    expect(statuses.every((s: { statusCategory: unknown }) => s.statusCategory)).toBe(true);
    const done = statuses.find((s: { id: string }) => s.id === '10003');
    expect(done.statusCategory).toEqual({ id: 3, key: 'done', name: 'Done' });
  });

  it('serialises the Sprint field the way the flavour does', async () => {
    const { get } = await start(flavor);
    const r = await get(`${searchPath(flavor)}?${jql('filter = 101')}`);
    const closed = r.body.issues.find(
      (i: { fields: Record<string, unknown> }) => i.fields[DEMO_SPRINT_FIELD],
    );
    const value = closed.fields[DEMO_SPRINT_FIELD] as unknown[];
    if (flavor === 'cloud') {
      expect(value[0]).toMatchObject({ id: 1, name: 'DEMO Sprint 1', state: 'closed' });
    } else {
      expect(value[0]).toMatch(
        /^com\.atlassian\.greenhopper\.service\.sprint\.Sprint@[0-9a-f]+\[id=1,rapidViewId=1,state=CLOSED,name=DEMO Sprint 1,startDate=\d{4}-\d\d-\d\dT[\d:.]+Z,endDate=\S+Z,completeDate=\S+Z,sequence=1,goal=Sprint 1 goal\]$/,
      );
    }
  });
});

describe.each(['cloud', 'datacenter'] as const)(
  'mock Jira project metadata and time tracking (%s)',
  (flavor) => {
    const api = flavor === 'cloud' ? '3' : '2';

    it('reports the working-time configuration', async () => {
      const { get } = await start(flavor);
      const r = await get(`/rest/api/${api}/configuration`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        timeTrackingEnabled: true,
        timeTrackingConfiguration: {
          workingHoursPerDay: 8,
          workingDaysPerWeek: 5,
          timeFormat: 'pretty',
          defaultUnit: 'hour',
        },
      });
    });

    it('pages the worklog of an issue', async () => {
      const { get } = await start(flavor);
      const all = await get(`/rest/api/${api}/issue/DEMO-1/worklog`);
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(2);
      expect(all.body.worklogs).toHaveLength(2);
      expect(all.body.worklogs[0]).toMatchObject({
        started: expect.any(String),
        timeSpentSeconds: 7200,
        timeSpent: '2h',
        comment: 'Pipeline <b>fix</b>',
      });
      expect(all.body.worklogs[0].author.displayName).toBeTruthy();
      if (flavor === 'cloud') {
        expect(all.body.worklogs[0].author).toMatchObject({ accountId: expect.any(String) });
      } else {
        expect(all.body.worklogs[0].author).toMatchObject({ key: expect.any(String) });
      }

      const first = await get(`/rest/api/${api}/issue/DEMO-1/worklog?maxResults=1`);
      expect(first.body.worklogs).toHaveLength(1);
      expect(first.body.startAt).toBe(0);
      const second = await get(`/rest/api/${api}/issue/DEMO-1/worklog?startAt=1&maxResults=1`);
      expect(second.body.startAt).toBe(1);
      expect(second.body.worklogs).toHaveLength(1);
      expect(second.body.worklogs[0].id).not.toBe(first.body.worklogs[0].id);

      expect((await get(`/rest/api/${api}/issue/NOPE-1/worklog`)).status).toBe(404);
    });

    it('lists watchers, with emailAddress in the raw mock answer', async () => {
      const { get } = await start(flavor);
      const r = await get(`/rest/api/${api}/issue/DEMO-1/watchers`);
      expect(r.status).toBe(200);
      expect(r.body.watchCount).toBe(1);
      expect(r.body.isWatching).toBe(false);
      expect(r.body.watchers).toHaveLength(1);
      expect(r.body.watchers[0].displayName).toBeTruthy();
      expect(r.body.watchers[0].emailAddress).toBeTruthy();
      expect((await get(`/rest/api/${api}/issue/NOPE-1/watchers`)).status).toBe(404);
    });

    it('lists issue link types', async () => {
      const { get } = await start(flavor);
      const r = await get(`/rest/api/${api}/issueLinkType`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
      });
    });

    it("lists a project's versions, 404 for an unknown project", async () => {
      const { get } = await start(flavor);
      const r = await get(`/rest/api/${api}/project/DEMO/versions`);
      expect(r.status).toBe(200);
      expect(r.body.map((v: { name: string }) => v.name)).toEqual(['1.0', '1.1']);
      expect((await get(`/rest/api/${api}/project/NOPE/versions`)).status).toBe(404);
    });

    it("lists a project's components, 404 for an unknown project", async () => {
      const { get } = await start(flavor);
      const r = await get(`/rest/api/${api}/project/DEMO/components`);
      expect(r.status).toBe(200);
      expect(r.body.map((c: { name: string }) => c.name)).toEqual(['API']);
      expect((await get(`/rest/api/${api}/project/NOPE/components`)).status).toBe(404);
    });

    it("lists a board's issues", async () => {
      const { get } = await start(flavor);
      const r = await get('/rest/agile/1.0/board/1/issue?maxResults=50');
      expect(r.status).toBe(200);
      expect(r.body.issues.map((i: { key: string }) => i.key)).toContain('DEMO-1');
      expect((await get('/rest/agile/1.0/board/999/issue')).status).toBe(404);
    });

    it('includes timetracking on issues that have it', async () => {
      const { get } = await start(flavor);
      const issue = await get(`/rest/api/${api}/issue/DEMO-1`);
      expect(issue.body.fields.timetracking).toMatchObject({ timeSpentSeconds: 50400 });
      const search = await get(`${searchPath(flavor)}?${jql('filter = 101')}`);
      const demo2 = search.body.issues.find((i: { key: string }) => i.key === 'DEMO-2');
      expect(demo2.fields.timetracking).toMatchObject({ timeSpentSeconds: 14400 });
    });
  },
);

describe('paging', () => {
  it('Cloud search pages with tokens and no total', async () => {
    const { get } = await start('cloud', { maxPageSize: 20 });
    const first = await get(`/rest/api/3/search/jql?${jql('filter = 101')}&maxResults=20`);
    expect(first.body.issues).toHaveLength(20);
    expect(first.body.isLast).toBe(false);
    expect(first.body.total).toBeUndefined();
    const second = await get(
      `/rest/api/3/search/jql?${jql('filter = 101')}&maxResults=20&nextPageToken=${first.body.nextPageToken}`,
    );
    expect(second.body.issues).toHaveLength(5);
    expect(second.body.isLast).toBe(true);
    expect(second.body.nextPageToken).toBeUndefined();
  });

  it('Data Center search pages with offsets and a total', async () => {
    const { get } = await start('datacenter', { maxPageSize: 20 });
    const second = await get(`/rest/api/2/search?${jql('filter = 101')}&startAt=20&maxResults=20`);
    expect(second.body).toMatchObject({ startAt: 20, maxResults: 20, total: 25 });
    expect(second.body.issues).toHaveLength(5);
  });
});

describe('long changelogs', () => {
  const longDataset = () => {
    const ds = demoDataset(ANCHOR);
    const issue = ds.issues[0];
    const template = issue?.histories[0];
    if (!issue || !template) throw new Error('dataset changed');
    issue.histories = Array.from({ length: 130 }, (_, n) => ({ ...template, id: String(n + 1) }));
    return { ds, key: issue.key };
  };

  it('truncates the inline changelog at 100 with total 130, and Cloud pages the rest', async () => {
    const { ds, key } = longDataset();
    const { get } = await start('cloud', { maxPageSize: 100 }, ds);
    const search = await get(`/rest/api/3/search/jql?${jql('filter = 101')}&maxResults=100`);
    const issue = search.body.issues.find((i: { key: string }) => i.key === key);
    expect(issue.changelog.total).toBe(130);
    expect(issue.changelog.histories).toHaveLength(100);
    const rest = await get(`/rest/api/3/issue/${key}/changelog?startAt=100&maxResults=100`);
    expect(rest.body).toMatchObject({ startAt: 100, total: 130, isLast: true });
    expect(rest.body.values).toHaveLength(30);
  });

  it('Data Center returns the full changelog from issue?expand=changelog', async () => {
    const { ds, key } = longDataset();
    const { get } = await start('datacenter', { maxPageSize: 100 }, ds);
    const issue = await get(`/rest/api/2/issue/${key}?expand=changelog`);
    expect(issue.body.changelog.histories).toHaveLength(130);
  });
});
