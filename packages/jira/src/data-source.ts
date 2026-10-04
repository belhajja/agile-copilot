import { createAgileClient, createCloudClient } from 'jira.js';
import { AgileClient, Version2Client } from 'jira-js-v5';
import { createNoRedirectClient, MAX_RESPONSE_BYTES } from './no-redirect-client';
import { offsetPager, type PaginationLimits, tokenPager } from './pagination';
import { type RetryOptions, withRateLimitRetry } from './rate-limit';
import {
  boardConfigSchema,
  boardPageSchema,
  changelogPageSchema,
  cloudSearchSchema,
  dcSearchSchema,
  fieldListSchema,
  issueChangelogSchema,
  sprintPageSchema,
  statusListSchema,
  toBoardInfo,
} from './responses';
import { sanitizeDataCenterError } from './sanitize-error';
import type {
  JiraBoardConfig,
  JiraBoardInfo,
  JiraFieldInfo,
  JiraSprintInfo,
  JiraStatusInfo,
  RawChangelogHistory,
  RawIssue,
} from './sync-types';
import type { JiraCredentials } from './types';

/** Read-only Jira access used by the sync. Same shape for Cloud (jira.js v6) and DC (v5). */
export interface JiraDataSource {
  listBoards(): Promise<JiraBoardInfo[]>;
  getBoardConfig(jiraBoardId: number): Promise<JiraBoardConfig>;
  /** Scrum boards only (Jira answers 400 for boards without sprints). */
  listSprints(jiraBoardId: number): Promise<JiraSprintInfo[]>;
  listStatuses(): Promise<JiraStatusInfo[]>;
  listFields(): Promise<JiraFieldInfo[]>;
  /** Pages of issues (with changelog, possibly truncated) for a JQL query. */
  searchIssues(jql: string, fields: string[]): AsyncGenerator<RawIssue[]>;
  /** Complete changelog of one issue. */
  getFullChangelog(issueKey: string): Promise<RawChangelogHistory[]>;
}

export interface DataSourceOptions {
  /** Atlassian API gateway origin (OAuth); overridable for tests. */
  atlassianApiBase?: string;
  /** Issues per search page (default 100). */
  pageSize?: number;
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number;
  /** Largest accepted response body (default 20 MB). */
  maxResponseBytes?: number;
  /** Per-call caps against a server that never stops paging (defaults 1000 pages, 200,000 items). */
  maxPages?: number;
  maxItems?: number;
  retry?: RetryOptions;
}

const PAGE = 50;
const limitsOf = (o: DataSourceOptions): PaginationLimits => ({
  maxPages: o.maxPages,
  maxItems: o.maxItems,
});
const INLINE_LIMIT = 100;

/** The issue's own changelog when complete, otherwise the full one fetched separately. */
export async function completeHistories(
  source: JiraDataSource,
  issue: RawIssue,
): Promise<RawChangelogHistory[]> {
  const log = issue.changelog;
  if (!log) return source.getFullChangelog(issue.key);
  // Jira truncates the changelog of a search hit at 100 histories. Without a `total` a full page
  // cannot be told from a truncated one, so fetch to be sure.
  const complete =
    log.total !== undefined
      ? log.histories.length >= log.total
      : log.histories.length < INLINE_LIMIT;
  return complete ? log.histories : source.getFullChangelog(issue.key);
}

type CloudCredentials = Exclude<JiraCredentials, { kind: 'datacenter_pat' }>;
type DataCenterCredentials = Extract<JiraCredentials, { kind: 'datacenter_pat' }>;

/** Fixed credentials, or a provider called before every request (OAuth tokens expire mid-sync). */
export type JiraCredentialsInput = JiraCredentials | (() => Promise<JiraCredentials>);

function flavour(
  c: JiraCredentials,
  getCreds: () => Promise<JiraCredentials>,
  opts: DataSourceOptions,
): JiraDataSource {
  const same = async () => {
    const fresh = await getCreds();
    if ((fresh.kind === 'datacenter_pat') !== (c.kind === 'datacenter_pat')) {
      throw new Error('The Jira deployment type of a connection cannot change.');
    }
    return fresh;
  };
  return c.kind === 'datacenter_pat'
    ? dataCenter(same as () => Promise<DataCenterCredentials>, opts)
    : cloud(same as () => Promise<CloudCredentials>, opts);
}

export function createJiraDataSource(
  creds: JiraCredentialsInput,
  opts: DataSourceOptions = {},
): JiraDataSource {
  if (typeof creds !== 'function') return flavour(creds, async () => creds, opts);
  // The first answer picks Cloud or Data Center; later requests ask the provider again.
  let impl: Promise<JiraDataSource> | undefined;
  const source = () => {
    impl ??= creds().then(
      (first) => flavour(first, creds, opts),
      (e) => {
        impl = undefined; // a transient provider failure must not break the source for good
        throw e;
      },
    );
    return impl;
  };
  return {
    listBoards: async () => (await source()).listBoards(),
    getBoardConfig: async (id) => (await source()).getBoardConfig(id),
    listSprints: async (id) => (await source()).listSprints(id),
    listStatuses: async () => (await source()).listStatuses(),
    listFields: async () => (await source()).listFields(),
    searchIssues: async function* (jql, fields) {
      yield* (await source()).searchIssues(jql, fields);
    },
    getFullChangelog: async (key) => (await source()).getFullChangelog(key),
  };
}

function cloud(getCreds: () => Promise<CloudCredentials>, opts: DataSourceOptions): JiraDataSource {
  // Credentials are read for every request, so an OAuth token refreshed mid-sync is picked up.
  const clients = async () => {
    const c = await getCreds();
    const client = createNoRedirectClient({
      ...(c.kind === 'cloud_basic'
        ? { host: c.baseUrl, auth: { type: 'basic', email: c.email, apiToken: c.apiToken } }
        : {
            host: `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${encodeURIComponent(c.cloudId)}`,
            auth: { type: 'bearer', token: c.accessToken },
          }),
      schemaValidation: 'lenient',
      timeoutMs: opts.timeoutMs,
      maxResponseBytes: opts.maxResponseBytes,
    });
    return { jira: createCloudClient(client), agile: createAgileClient(client) };
  };
  const call = <T>(fn: (k: Awaited<ReturnType<typeof clients>>) => Promise<T>) =>
    withRateLimitRetry(async () => fn(await clients()), opts.retry);
  const pageSize = opts.pageSize ?? 100;

  return {
    async listBoards() {
      const boards: JiraBoardInfo[] = [];
      const pager = offsetPager(PAGE, limitsOf(opts));
      for (let startAt = 0; ; ) {
        const page = boardPageSchema.parse(
          await call((k) => k.agile.board.getAllBoards({ startAt, maxResults: PAGE })),
        );
        boards.push(...pager.fresh(page.values, (b) => b.id).map(toBoardInfo));
        startAt += page.values.length;
        if (pager.done(page, page.values.length)) return boards;
      }
    },
    async getBoardConfig(boardId) {
      return boardConfigSchema.parse(
        await call((k) => k.agile.board.getConfiguration({ boardId })),
      );
    },
    async listSprints(boardId) {
      const sprints: JiraSprintInfo[] = [];
      const pager = offsetPager(PAGE, limitsOf(opts));
      for (let startAt = 0; ; ) {
        const page = sprintPageSchema.parse(
          await call((k) => k.agile.board.getAllSprints({ boardId, startAt, maxResults: PAGE })),
        );
        sprints.push(...pager.fresh(page.values, (x) => x.jiraSprintId));
        startAt += page.values.length;
        if (pager.done(page, page.values.length)) return sprints;
      }
    },
    async listStatuses() {
      return statusListSchema.parse(await call((k) => k.jira.workflowStatuses.getStatuses()));
    },
    async listFields() {
      return fieldListSchema.parse(await call((k) => k.jira.issueFields.getFields()));
    },
    async *searchIssues(jql, fields) {
      let nextPageToken: string | undefined;
      const pager = tokenPager(limitsOf(opts));
      do {
        const token = nextPageToken;
        const page = cloudSearchSchema.parse(
          await call((k) =>
            k.jira.issueSearch.searchAndReconsileIssuesUsingJql({
              jql,
              nextPageToken: token,
              maxResults: pageSize,
              fields,
              expand: 'changelog',
            }),
          ),
        );
        const issues = pager.fresh(page.issues, (i) => i.id);
        if (issues.length > 0) yield issues;
        nextPageToken = pager.next(page.isLast, page.nextPageToken);
      } while (nextPageToken);
    },
    async getFullChangelog(issueKey) {
      const histories: RawChangelogHistory[] = [];
      const pager = offsetPager(100, limitsOf(opts));
      for (let startAt = 0; ; ) {
        const page = changelogPageSchema.parse(
          await call((k) =>
            k.jira.issues.getChangeLogs({ issueIdOrKey: issueKey, startAt, maxResults: 100 }),
          ),
        );
        histories.push(...pager.fresh(page.values, (h) => h.id));
        startAt += page.values.length;
        if (pager.done(page, page.values.length)) return histories;
      }
    },
  };
}

function dataCenter(
  getCreds: () => Promise<DataCenterCredentials>,
  opts: DataSourceOptions,
): JiraDataSource {
  const clients = async () => {
    const c = await getCreds();
    const config = {
      host: c.baseUrl,
      authentication: { oauth2: { accessToken: c.token } },
      // Never follow redirects (SSRF); bound every request.
      baseRequestConfig: {
        maxRedirects: 0,
        timeout: opts.timeoutMs ?? 30_000,
        maxContentLength: opts.maxResponseBytes ?? MAX_RESPONSE_BYTES,
        maxBodyLength: opts.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      },
    };
    return { v2: new Version2Client(config), agile: new AgileClient(config) };
  };
  const call = <T>(fn: (k: Awaited<ReturnType<typeof clients>>) => Promise<T>) =>
    withRateLimitRetry(async () => {
      const k = await clients();
      try {
        return await fn(k);
      } catch (e) {
        throw sanitizeDataCenterError(e);
      }
    }, opts.retry);
  const pageSize = opts.pageSize ?? 100;

  return {
    async listBoards() {
      const boards: JiraBoardInfo[] = [];
      const pager = offsetPager(PAGE, limitsOf(opts));
      for (let startAt = 0; ; ) {
        const page = boardPageSchema.parse(
          await call((k) => k.agile.board.getAllBoards<unknown>({ startAt, maxResults: PAGE })),
        );
        boards.push(...pager.fresh(page.values, (b) => b.id).map(toBoardInfo));
        startAt += page.values.length;
        if (pager.done(page, page.values.length)) return boards;
      }
    },
    async getBoardConfig(boardId) {
      return boardConfigSchema.parse(
        await call((k) => k.agile.board.getConfiguration<unknown>({ boardId })),
      );
    },
    async listSprints(boardId) {
      const sprints: JiraSprintInfo[] = [];
      const pager = offsetPager(PAGE, limitsOf(opts));
      for (let startAt = 0; ; ) {
        const page = sprintPageSchema.parse(
          await call((k) =>
            k.agile.board.getAllSprints<unknown>({ boardId, startAt, maxResults: PAGE }),
          ),
        );
        sprints.push(...pager.fresh(page.values, (x) => x.jiraSprintId));
        startAt += page.values.length;
        if (pager.done(page, page.values.length)) return sprints;
      }
    },
    async listStatuses() {
      return statusListSchema.parse(
        await call((k) => k.v2.workflowStatuses.getStatuses<unknown>()),
      );
    },
    async listFields() {
      return fieldListSchema.parse(await call((k) => k.v2.issueFields.getFields<unknown>()));
    },
    async *searchIssues(jql, fields) {
      const pager = offsetPager(pageSize, limitsOf(opts));
      for (let startAt = 0; ; ) {
        const page = dcSearchSchema.parse(
          await call((k) =>
            k.v2.issueSearch.searchForIssuesUsingJql<unknown>({
              jql,
              startAt,
              maxResults: pageSize,
              fields,
              expand: 'changelog',
            }),
          ),
        );
        const issues = pager.fresh(page.issues, (i) => i.id);
        if (issues.length > 0) yield issues;
        startAt += page.issues.length;
        if (pager.done(page, page.issues.length)) return;
      }
    },
    async getFullChangelog(issueKey) {
      // Data Center returns the whole changelog with the issue.
      const issue = issueChangelogSchema.parse(
        await call((k) =>
          k.v2.issues.getIssue<unknown>({
            issueIdOrKey: issueKey,
            expand: 'changelog',
            fields: ['status'],
          }),
        ),
      );
      return issue.changelog?.histories ?? [];
    },
  };
}
