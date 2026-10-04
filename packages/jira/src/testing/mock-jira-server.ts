import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseJiraDate } from '../issue-normalize';
import type { MockIssue, MockJiraDataset } from './demo-dataset';

export {
  DEMO_SPRINT_FIELD,
  DEMO_STORY_POINTS,
  demoDataset,
  jiraTime,
  type MockBoard,
  type MockIssue,
  type MockJiraDataset,
  type MockSprint,
} from './demo-dataset';

export interface MockJiraOptions {
  flavor: 'cloud' | 'datacenter';
  /** Exact Authorization header value that is accepted, e.g. "Bearer good-pat". */
  validAuthorization: string;
  /** e.g. "/jira" (DC context path) or "/ex/jira/cloud-123" (OAuth gateway). */
  pathPrefix?: string;
  /** Boards, sprints, statuses, fields and issues served by the agile/search endpoints. */
  dataset?: MockJiraDataset;
  /** Answer the first N data requests with 429 and a Retry-After header. */
  rateLimitFirst?: number;
  retryAfterSeconds?: number;
  /** Largest page served whatever maxResults asks (exercises pagination). Default 50. */
  maxPageSize?: number;
  /**
   * Return at most this many changelog histories in search results (total stays complete).
   * Default 100, like Jira, so a longer history comes back truncated.
   */
  searchChangelogLimit?: number;
  /** Clock for relative JQL dates. */
  now?: () => Date;
}

export interface MockJira {
  url: string;
  requests: { path: string; search: string; authorization?: string }[];
  close(): Promise<void>;
}

const CLOUD_MYSELF = {
  self: 'https://acme.atlassian.net/rest/api/3/user?accountId=acc-1',
  accountId: 'acc-1',
  accountType: 'atlassian',
  emailAddress: 'pm@acme.com',
  displayName: 'Pat Cloud',
  active: true,
  timeZone: 'Europe/Paris',
  locale: 'en_US',
  avatarUrls: {},
};
const CLOUD_SERVER_INFO = {
  baseUrl: 'https://acme.atlassian.net',
  version: '1001.0.0-SNAPSHOT',
  versionNumbers: [1001, 0, 0],
  deploymentType: 'Cloud',
  buildNumber: 100,
  buildDate: '2026-09-30T00:00:00.000+0000',
  serverTime: '2026-10-03T00:00:00.000+0000',
  scmInfo: 'abc',
  serverTitle: 'Jira',
  defaultLocale: { locale: 'en_US' },
};
const DC_MYSELF = { self: 'x', key: 'JIRAUSER1', name: 'pat', displayName: 'Pat DC', active: true };
const DC_SERVER_INFO = {
  baseUrl: 'https://jira.corp.example',
  version: '10.3.0',
  versionNumbers: [10, 3, 0],
  deploymentType: 'Server',
  buildNumber: 10030000,
  serverTitle: 'Corp Jira',
};

const CATEGORY = {
  new: { id: 2, name: 'To Do' },
  indeterminate: { id: 4, name: 'In Progress' },
  done: { id: 3, name: 'Done' },
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Issues matching `filter = N [AND updated >= "-Mm"]`, oldest first; null for unsupported JQL. */
function runJql(dataset: MockJiraDataset, jql: string, now: Date): MockIssue[] | null {
  const filter = /filter\s*=\s*(\d+)/i.exec(jql);
  if (!filter) return null;
  const filterId = Number(filter[1]);
  const since = /updated\s*>=\s*"-(\d+)m"/i.exec(jql);
  const from = since ? now.getTime() - Number(since[1]) * 60_000 : Number.NEGATIVE_INFINITY;
  const time = (v: unknown) => parseJiraDate(v)?.getTime() ?? 0;
  return dataset.issues
    .filter((i) => i.filterIds.includes(filterId) && time(i.fields.updated) >= from)
    .sort((a, b) => time(a.fields.created) - time(b.fields.created) || Number(a.id) - Number(b.id));
}

export async function startMockJira(opts: MockJiraOptions): Promise<MockJira> {
  const api = opts.flavor === 'cloud' ? '3' : '2';
  const prefix = opts.pathPrefix ?? '';
  const maxPage = opts.maxPageSize ?? 50;
  const now = opts.now ?? (() => new Date());
  const requests: MockJira['requests'] = [];
  let throttled = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    const q = url.searchParams;
    requests.push({ path, search: url.search, authorization: req.headers.authorization });
    if (req.headers.authorization !== opts.validAuthorization) {
      return json(res, 401, { errorMessages: ['You are not authenticated.'] });
    }
    if (path === `${prefix}/rest/api/${api}/myself`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_MYSELF : DC_MYSELF);
    }
    if (path === `${prefix}/rest/api/${api}/serverInfo`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_SERVER_INFO : DC_SERVER_INFO);
    }
    const ds = opts.dataset;
    if (!ds) return json(res, 404, { errorMessages: ['Not found'] });
    if (throttled < (opts.rateLimitFirst ?? 0)) {
      throttled++;
      res.writeHead(429, { 'retry-after': String(opts.retryAfterSeconds ?? 1) });
      return res.end();
    }

    const startAt = Number(q.get('startAt') ?? 0);
    const size = Math.min(Number(q.get('maxResults') ?? maxPage), maxPage);
    const page = <T>(all: T[]) => ({
      startAt,
      maxResults: size,
      total: all.length,
      isLast: startAt + size >= all.length,
      values: all.slice(startAt, startAt + size),
    });
    const agile = `${prefix}/rest/agile/1.0/board`;

    if (path === agile) {
      return json(
        res,
        200,
        page(
          ds.boards.map((b) => ({
            id: b.id,
            name: b.name,
            type: b.type,
            location: { projectKey: b.projectKey, projectName: b.projectKey },
          })),
        ),
      );
    }
    const boardRoute = new RegExp(`^${agile}/(\\d+)/(configuration|sprint)$`).exec(path);
    if (boardRoute) {
      const board = ds.boards.find((b) => b.id === Number(boardRoute[1]));
      if (!board) return json(res, 404, { errorMessages: ['Board not found'] });
      if (boardRoute[2] === 'configuration') {
        return json(res, 200, {
          id: board.id,
          name: board.name,
          filter: { id: String(board.filterId) },
          columnConfig: {
            columns: board.columns.map((c) => ({
              name: c.name,
              statuses: c.statusIds.map((id) => ({ id })),
            })),
          },
          ...(board.estimation ? { estimation: { type: 'field', field: board.estimation } } : {}),
        });
      }
      if (board.type !== 'scrum') {
        return json(res, 400, { errorMessages: ['The board does not support sprints'] });
      }
      return json(
        res,
        200,
        page(
          ds.sprints
            .filter((s) => s.boardId === board.id)
            .map(({ boardId, ...s }) => ({ ...s, originBoardId: boardId })),
        ),
      );
    }
    if (path === `${prefix}/rest/api/${api}/status`) {
      return json(
        res,
        200,
        ds.statuses.map((s) => ({
          id: s.id,
          name: s.name,
          statusCategory: { key: s.categoryKey },
        })),
      );
    }
    if (path === `${prefix}/rest/api/${api}/field`) {
      return json(
        res,
        200,
        ds.fields.map((f) => ({
          id: f.id,
          name: f.name,
          custom: f.custom,
          ...(f.schemaCustom ? { schema: { type: 'any', custom: f.schemaCustom } } : {}),
        })),
      );
    }
    const categoryOf = (statusId: unknown) => {
      const key = ds.statuses.find((st) => st.id === statusId)?.categoryKey ?? 'new';
      return { id: CATEGORY[key].id, key, name: CATEGORY[key].name };
    };
    const withCategory = (status: unknown) => {
      const s = status as { id?: unknown } | null;
      return s ? { ...s, statusCategory: categoryOf(s.id) } : s;
    };
    // Data Center serialises the Sprint field as greenhopper toString() text, Cloud as objects.
    const sprintValue = (value: unknown) => {
      if (opts.flavor === 'cloud' || !Array.isArray(value)) return value;
      return value.map((v: { id: number }) => {
        const sp = ds.sprints.find((x) => x.id === v.id);
        const date = (d?: string) => (d ? d.replace('+0000', 'Z') : '<null>');
        return `com.atlassian.greenhopper.service.sprint.Sprint@${v.id.toString(16).padStart(6, '0')}[id=${v.id},rapidViewId=${sp?.boardId ?? 1},state=${(sp?.state ?? 'future').toUpperCase()},name=${sp?.name ?? ''},startDate=${date(sp?.startDate)},endDate=${date(sp?.endDate)},completeDate=${date(sp?.completeDate)},sequence=${v.id},goal=${sp?.goal ?? ''}]`;
      });
    };
    const issueJson = (i: MockIssue) => {
      const limit = opts.searchChangelogLimit ?? 100;
      const fields: Record<string, unknown> = {
        ...i.fields,
        status: withCategory(i.fields.status),
      };
      for (const f of ds.fields) {
        if (f.schemaCustom?.endsWith(':gh-sprint')) fields[f.id] = sprintValue(fields[f.id]);
      }
      return {
        id: i.id,
        key: i.key,
        fields,
        changelog: {
          startAt: 0,
          maxResults: limit,
          total: i.histories.length,
          histories: i.histories.slice(0, limit),
        },
      };
    };
    const searchPath =
      opts.flavor === 'cloud' ? `${prefix}/rest/api/3/search/jql` : `${prefix}/rest/api/2/search`;
    if (path === searchPath) {
      const found = runJql(ds, q.get('jql') ?? '', now());
      if (!found) return json(res, 400, { errorMessages: ['Unsupported JQL in mock'] });
      if (opts.flavor === 'cloud') {
        const from = Number(q.get('nextPageToken') ?? 0);
        const slice = found.slice(from, from + size);
        const next = from + slice.length;
        return json(res, 200, {
          issues: slice.map(issueJson),
          ...(next < found.length ? { nextPageToken: String(next) } : {}),
          isLast: next >= found.length,
        });
      }
      return json(res, 200, {
        startAt,
        maxResults: size,
        total: found.length,
        issues: found.slice(startAt, startAt + size).map(issueJson),
      });
    }
    const changelog = new RegExp(`^${prefix}/rest/api/3/issue/([^/]+)/changelog$`).exec(path);
    if (changelog && opts.flavor === 'cloud') {
      const issue = ds.issues.find((i) => i.key === changelog[1] || i.id === changelog[1]);
      if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist'] });
      return json(res, 200, page(issue.histories));
    }
    const single = new RegExp(`^${prefix}/rest/api/2/issue/([^/]+)$`).exec(path);
    if (single && opts.flavor === 'datacenter') {
      const issue = ds.issues.find((i) => i.key === single[1] || i.id === single[1]);
      if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist'] });
      return json(res, 200, {
        id: issue.id,
        key: issue.key,
        fields: { status: withCategory(issue.fields.status) },
        changelog: {
          startAt: 0,
          maxResults: issue.histories.length,
          total: issue.histories.length,
          histories: issue.histories,
        },
      });
    }
    json(res, 404, { errorMessages: ['Not found'] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Clients keep connections alive; without this close() waits for the keep-alive timeout.
        server.closeAllConnections();
      }),
  };
}
