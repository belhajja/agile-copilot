import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseJiraDate } from '../issue-normalize';
import { jiraTime, type MockIssue, type MockJiraDataset } from './demo-dataset';

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

/** A write the agent's Jira tools sent (comment, transition, assignment, creation, edit). */
export interface MockJiraWrite {
  method: string;
  path: string;
  body: unknown;
  authorization?: string;
}

export interface MockJira {
  url: string;
  requests: { path: string; search: string; authorization?: string }[];
  /** Successful writes, in order. */
  writes: MockJiraWrite[];
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

/** The issues whose Sprint field contains sprint `sprintId` (one lookup for JQL and the agile API). */
function sprintMemberIssues(dataset: MockJiraDataset, sprintId: number): MockIssue[] {
  const field = dataset.fields.find((f) => f.schemaCustom?.endsWith(':gh-sprint'))?.id;
  return dataset.issues.filter((i) =>
    ((field ? i.fields[field] : null) as { id: number }[] | null)?.some((s) => s.id === sprintId),
  );
}

/**
 * Issues matching `filter = N [AND updated >= "-Mm"]` or `sprint = N` (how mcp-atlassian lists a
 * sprint's issues), oldest first; null for unsupported JQL.
 */
function runJql(dataset: MockJiraDataset, jql: string, now: Date): MockIssue[] | null {
  const sprint = /^\s*sprint\s*=\s*(\d+)\s*$/i.exec(jql);
  if (sprint) return sprintMemberIssues(dataset, Number(sprint[1]));
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

const INVALID_JSON = Symbol('invalid json');

/** The parsed JSON body (undefined when empty); INVALID_JSON when it does not parse. */
const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(INVALID_JSON);
      }
    });
  });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Own-property merge that never touches the prototype chain. */
function safeAssign(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [k, v] of Object.entries(source)) {
    if (!UNSAFE_KEYS.has(k)) target[k] = v;
  }
}

/** Fields a client cannot set through an edit. */
const READ_ONLY_FIELDS = ['status', 'created', 'updated', 'id', 'key'];

export async function startMockJira(opts: MockJiraOptions): Promise<MockJira> {
  const api = opts.flavor === 'cloud' ? '3' : '2';
  const prefix = opts.pathPrefix ?? '';
  const maxPage = opts.maxPageSize ?? 50;
  const now = opts.now ?? (() => new Date());
  const requests: MockJira['requests'] = [];
  const writes: MockJiraWrite[] = [];
  const comments = new Map<string, { id: string; body: unknown; created: string }[]>();
  let throttled = 0;
  let nextId = 90_000;

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
      const sprints = ds.sprints.filter((s) => s.boardId === board.id);
      // Kanban boards, and team-managed boards whose project has sprints turned off, have none.
      if (board.type === 'kanban' || (board.type === 'simple' && sprints.length === 0)) {
        return json(res, 400, { errorMessages: ['The board does not support sprints'] });
      }
      return json(
        res,
        200,
        page(sprints.map(({ boardId, ...s }) => ({ ...s, originBoardId: boardId }))),
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
    if (issueRoutes(req, res, path, { categoryOf, issueJson })) return;
    json(res, 404, { errorMessages: ['Not found'] });
  });
  const knownUsers = (ds: MockJiraDataset) => {
    const users = new Map<string, Record<string, unknown>>();
    for (const i of ds.issues) {
      const a = i.fields.assignee as Record<string, unknown> | null;
      if (a && typeof a.accountId === 'string') users.set(a.accountId, a);
    }
    return users;
  };

  // ---- Issue detail and the writes the agent's Jira tools use (REST v2 and v3 alike) ----
  function issueRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    h: {
      categoryOf: (statusId: unknown) => unknown;
      issueJson: (i: MockIssue) => { fields: Record<string, unknown> };
    },
  ): boolean {
    const { categoryOf, issueJson } = h;
    const ds = opts.dataset;
    if (!ds) return false;
    const route = new RegExp(
      `^${prefix}/rest/api/[23]/issue(?:/([^/]+)(?:/(comment|transitions|assignee))?)?$`,
    ).exec(path);
    const sprintIssues = new RegExp(`^${prefix}/rest/agile/1\\.0/sprint/(\\d+)/issue$`).exec(path);
    if (sprintIssues && req.method === 'GET') {
      const found = sprintMemberIssues(ds, Number(sprintIssues[1]));
      json(res, 200, {
        startAt: 0,
        maxResults: 50,
        total: found.length,
        issues: found.map(issueJson),
      });
      return true;
    }
    if (new RegExp(`^${prefix}/rest/api/[23]/user/search$`).test(path) && req.method === 'GET') {
      // Users are the dataset's assignees; DC matches `username`, Cloud matches `query`.
      const params = new URL(req.url ?? '/', 'http://mock').searchParams;
      const wanted = (params.get('query') || params.get('username') || '').toLowerCase();
      if (!wanted) {
        json(res, 400, { errorMessages: ['The query parameter is required.'] });
        return true;
      }
      const users = knownUsers(ds);
      json(
        res,
        200,
        [...users.values()]
          .filter((u) =>
            [u.accountId, u.name, u.displayName].some(
              (v) => typeof v === 'string' && v.toLowerCase().includes(wanted),
            ),
          )
          .map((u) =>
            opts.flavor === 'cloud'
              ? { accountId: u.accountId, displayName: u.displayName, active: true }
              : { key: u.key, name: u.name, displayName: u.displayName, active: true },
          ),
      );
      return true;
    }
    if (!route) return false;
    const [, key, sub] = route;
    const issue = key ? ds.issues.find((i) => i.key === key || i.id === key) : undefined;
    if (key && !issue) {
      json(res, 404, {
        errorMessages: ['Issue does not exist or you do not have permission to see it.'],
      });
      return true;
    }
    const record = (body: unknown) =>
      writes.push({
        method: req.method ?? '',
        path,
        body,
        authorization: req.headers.authorization,
      });

    if (req.method === 'GET' && issue && !sub) {
      const own = comments.get(issue.key) ?? [];
      const detail = issueJson(issue);
      json(res, 200, {
        ...detail,
        fields: {
          ...detail.fields,
          description: issue.fields.description ?? null,
          comment: { comments: own, total: own.length, maxResults: own.length, startAt: 0 },
        },
        changelog: {
          startAt: 0,
          maxResults: issue.histories.length,
          total: issue.histories.length,
          histories: issue.histories,
        },
      });
      return true;
    }
    if (req.method === 'GET' && issue && sub === 'transitions') {
      json(res, 200, {
        // Numeric ids like Jira's (mcp-atlassian parses them as integers): 11, 21, 31…
        transitions: ds.statuses.map((s, i) => ({
          id: String(11 + 10 * i),
          name: s.name,
          to: { id: s.id, name: s.name, statusCategory: categoryOf(s.id) },
        })),
      });
      return true;
    }
    if (req.method === 'GET' && issue && sub === 'comment') {
      const own = comments.get(issue.key) ?? [];
      json(res, 200, { comments: own, total: own.length, maxResults: own.length, startAt: 0 });
      return true;
    }
    if (req.method !== 'POST' && req.method !== 'PUT') return false;
    void readBody(req).then((body) => {
      if (body === INVALID_JSON) return json(res, 400, { errorMessages: ['Invalid JSON'] });
      if (!isPlainObject(body)) {
        return json(res, 400, { errorMessages: ['A JSON object body is required.'] });
      }
      const b = body as {
        body?: unknown;
        transition?: { id?: string };
        fields?: unknown;
      };
      const touch = (i: MockIssue) => {
        i.fields.updated = jiraTime(now());
      };
      if (req.method === 'POST' && issue && sub === 'comment') {
        if (b.body === undefined)
          return json(res, 400, { errors: { comment: 'Comment body can not be empty!' } });
        const comment = { id: String(nextId++), body: b.body, created: jiraTime(now()) };
        comments.set(issue.key, [...(comments.get(issue.key) ?? []), comment]);
        touch(issue);
        record(body);
        return json(res, 201, { ...comment, author: { displayName: 'Pat' } });
      }
      if (req.method === 'POST' && issue && sub === 'transitions') {
        const to = ds.statuses.find((_, i) => String(11 + 10 * i) === String(b.transition?.id));
        if (!to) return json(res, 400, { errorMessages: ['Transition is not valid.'] });
        const from = issue.fields.status as { id?: string; name?: string } | null;
        issue.histories.push({
          id: String(nextId++),
          created: jiraTime(now()),
          items: [
            {
              field: 'status',
              fieldId: 'status',
              fieldtype: 'jira',
              from: from?.id ?? null,
              fromString: from?.name ?? null,
              to: to.id,
              toString: to.name,
            },
          ],
        });
        issue.fields.status = { id: to.id, name: to.name };
        touch(issue);
        record(body);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'PUT' && issue && sub === 'assignee') {
        // Cloud identifies the user by `accountId`, Data Center by `name`; null unassigns.
        const prop = opts.flavor === 'cloud' ? 'accountId' : 'name';
        const wanted = body[prop];
        if (!(prop in body) || (wanted !== null && typeof wanted !== 'string')) {
          return json(res, 400, { errorMessages: [`The assignee must be given as ${prop}.`] });
        }
        const user =
          wanted === null ? null : [...knownUsers(ds).values()].find((u) => u[prop] === wanted);
        if (wanted !== null && !user) {
          return json(res, 404, { errorMessages: ['The user does not exist.'] });
        }
        issue.fields.assignee = user;
        touch(issue);
        record(body);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'PUT' && issue && !sub) {
        if (!isPlainObject(b.fields)) {
          return json(res, 400, { errorMessages: ['`fields` must be an object.'] });
        }
        const locked = READ_ONLY_FIELDS.find((f) => Object.hasOwn(b.fields as object, f));
        if (locked) {
          return json(res, 400, { errors: { [locked]: `Field '${locked}' cannot be set.` } });
        }
        safeAssign(issue.fields, b.fields);
        touch(issue);
        record(body);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && !key) {
        if (!isPlainObject(b.fields)) {
          return json(res, 400, { errorMessages: ['`fields` must be an object.'] });
        }
        const f = b.fields;
        const project = isPlainObject(f.project) ? f.project.key : undefined;
        const summary = f.summary;
        const projects = new Set([
          ...ds.boards.map((x) => x.projectKey),
          ...ds.issues.map((x) => x.key.slice(0, x.key.lastIndexOf('-'))),
        ]);
        if (typeof project !== 'string' || !projects.has(project)) {
          return json(res, 400, { errors: { project: 'You must specify a valid project.' } });
        }
        if (typeof summary !== 'string' || !summary) {
          return json(res, 400, {
            errors: { summary: 'You must specify a summary of the issue.' },
          });
        }
        const numbers = ds.issues
          .filter((i) => i.key.startsWith(`${project}-`))
          .map((i) => Number(i.key.slice(project.length + 1)));
        const created: MockIssue = {
          id: String(nextId++),
          key: `${project}-${Math.max(0, ...numbers) + 1}`,
          filterIds: [], // not on any board: a sync never sees it
          fields: {
            summary,
            description: f.description ?? null,
            issuetype: { name: (f.issuetype as { name?: string } | undefined)?.name ?? 'Task' },
            status: { id: ds.statuses[0]?.id, name: ds.statuses[0]?.name },
            assignee: null,
            created: jiraTime(now()),
            updated: jiraTime(now()),
          },
          histories: [],
        };
        ds.issues.push(created);
        record(body);
        return json(res, 201, {
          id: created.id,
          key: created.key,
          self: `${prefix}/rest/api/2/issue/${created.id}`,
        });
      }
      json(res, 404, { errorMessages: ['Not found'] });
    });
    return true;
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    writes,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Clients keep connections alive; without this close() waits for the keep-alive timeout.
        server.closeAllConnections();
      }),
  };
}
