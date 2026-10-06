import { type JiraCredentials, ResponseTooLargeError, readCapped } from '@agile/jira';
import { createOutboundFetch, isBlockedAddressError, type OutboundPolicy } from '@agile/net';
import {
  callSignal,
  codeForStatus,
  exactPerson,
  isoTime,
  type JiraToolBackend,
  JiraToolError,
  type JiraToolErrorCode,
  type JiraUserCandidate,
  worklogStarted,
} from './backend';
import { isJiraToolName, type JiraToolInput, type JiraToolName } from './catalog';
import { timeTrackingFromRest } from './time-tracking';
import { markdownToJiraWiki as wiki } from './wiki';
import {
  summarizeWorklogs,
  type Worklog,
  type WorklogEntry,
  worklogEntry,
  worklogOf,
} from './worklog-summary';

type RestCredentials = Extract<JiraCredentials, { kind: 'cloud_basic' | 'datacenter_pat' }>;

const MAX_BODY = 5 * 1024 * 1024;
const FIELDS = 'summary,status,assignee,issuetype,updated,labels,timetracking';

interface RawIssue {
  key?: string;
  fields?: {
    summary?: unknown;
    status?: { name?: unknown };
    assignee?: { displayName?: unknown } | null;
    issuetype?: { name?: unknown };
    updated?: unknown;
    labels?: unknown;
    description?: unknown;
    timetracking?: unknown;
    comment?: {
      comments?: { author?: { displayName?: unknown }; body?: unknown; created?: unknown }[];
    };
  };
}

interface RawUser {
  accountId?: unknown;
  name?: unknown;
  displayName?: unknown;
  emailAddress?: unknown;
  active?: unknown;
  accountType?: unknown;
}

/**
 * Connection errors raised before a single byte of the request left: refused, unresolvable or
 * unroutable hosts, a connect timeout, a TLS handshake failure. Anything else may come after.
 */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_)|CERT/;

function neverSent(e: unknown): boolean {
  for (let cause = e, depth = 0; cause && depth < 5; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && (NOT_SENT_CODES.has(code) || TLS_CODE.test(code))) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

const s = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const brief = (i: RawIssue) => ({
  key: s(i.key),
  summary: s(i.fields?.summary),
  status: s(i.fields?.status?.name),
  assignee: s(i.fields?.assignee?.displayName),
  type: s(i.fields?.issuetype?.name),
  updated: isoTime(i.fields?.updated),
  timeTracking: timeTrackingFromRest(i.fields?.timetracking),
});

/**
 * Jira tools over Jira's REST API with our own redirect-refusing, DNS-pinned client. Used for Cloud
 * API-token connections, which mcp-atlassian can only serve from one instance per site (see the
 * Phase 3 rulings), and by the e2e double. REST v2 everywhere: on Cloud it still takes and returns
 * wiki-markup bodies (no ADF). The model's Markdown (comments, descriptions) is converted exactly as
 * mcp-atlassian converts it, so both backends post the same text (ruling P3-R19).
 */
export function createRestJiraBackend(
  creds: RestCredentials,
  opts: { outbound: OutboundPolicy; timeoutMs?: number },
): JiraToolBackend {
  const fetch = createOutboundFetch(opts.outbound);
  const authorization =
    creds.kind === 'cloud_basic'
      ? `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`
      : `Bearer ${creds.token}`;
  const base = creds.baseUrl.replace(/\/+$/, '');
  const cloud = creds.kind === 'cloud_basic';

  async function request(
    signal: AbortSignal,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const write = method !== 'GET';
    let res: Response;
    try {
      res = await fetch(new URL(base + path), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (isBlockedAddressError(e)) throw new JiraToolError('blocked_url');
      // A write cut off once its request may have left (reset, abort, deadline) can have run in
      // Jira: say so. Only a failure to connect at all proves it was never sent.
      throw new JiraToolError(write && !neverSent(e) ? 'unknown_outcome' : 'unavailable');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new JiraToolError(codeForStatus(res.status));
    }
    // From here on Jira accepted the request: a write whose answer cannot be read did run, but
    // what it did is unknown (P3 #43).
    const unreadable = (code: JiraToolErrorCode) =>
      new JiraToolError(write ? 'unknown_outcome' : code);
    let text: string;
    try {
      // Counts bytes while streaming and aborts above the cap: a hostile Jira cannot make us buffer it.
      text = await readCapped(res, MAX_BODY);
    } catch (e) {
      throw unreadable(e instanceof ResponseTooLargeError ? 'jira_error' : 'unavailable');
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw unreadable('jira_error');
    }
  }
  const q = (params: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
    return `?${sp}`;
  };
  const issuePath = (key: string) => `/rest/api/2/issue/${encodeURIComponent(key)}`;

  /** The one active person `identifier` names exactly (see `exactPerson`). */
  async function findUser(signal: AbortSignal, identifier: string): Promise<JiraUserCandidate> {
    const found = (await request(
      signal,
      'GET',
      `/rest/api/2/user/search${q(cloud ? { query: identifier } : { username: identifier })}`,
    )) as unknown;
    const people = (Array.isArray(found) ? (found as RawUser[]) : []).flatMap((u) => {
      if (!u || typeof u !== 'object') return [];
      const id = s(cloud ? u.accountId : u.name);
      return id
        ? [
            {
              person: { id, displayName: s(u.displayName) ?? id },
              keys: [u.accountId, u.name, u.displayName, u.emailAddress],
              active: u.active,
              accountType: u.accountType,
            },
          ]
        : [];
    });
    return exactPerson(people, identifier, { cloud });
  }

  /** Worklog pages, at most 5 × 100 entries; more than that is flagged partial. */
  async function readWorklog(signal: AbortSignal, issueKey: string): Promise<Worklog> {
    const PAGE = 100;
    const MAX_PAGES = 5;
    const entries: WorklogEntry[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await request(
        signal,
        'GET',
        `${issuePath(issueKey)}/worklog${q({ startAt, maxResults: PAGE })}`,
      )) as { worklogs?: unknown[]; total?: unknown };
      const batch = r?.worklogs ?? [];
      for (const v of batch) {
        const w = (v ?? {}) as Record<string, unknown>;
        const e = worklogEntry({
          author: ((w.author ?? {}) as Record<string, unknown>).displayName,
          started: worklogStarted(w.started),
          seconds: w.timeSpentSeconds,
          comment: w.comment,
        });
        if (e) entries.push(e);
      }
      startAt += batch.length;
      const total = n(r?.total);
      if (batch.length === 0 || total === null || startAt >= total)
        return worklogOf(issueKey, entries, false);
    }
    return worklogOf(issueKey, entries, true);
  }

  const handlers: {
    [N in JiraToolName]: (input: JiraToolInput<N>, signal: AbortSignal) => Promise<unknown>;
  } = {
    async jira_search({ jql, limit }, signal) {
      const path = cloud ? '/rest/api/3/search/jql' : '/rest/api/2/search';
      const page = (await request(
        signal,
        'GET',
        path + q({ jql, maxResults: limit, fields: FIELDS }),
      )) as {
        issues?: RawIssue[];
        total?: unknown;
        isLast?: unknown;
        nextPageToken?: unknown;
      };
      const issues = (page?.issues ?? []).slice(0, limit).map(brief);
      if (cloud) {
        // /search/jql has no total: say whether more exist rather than inventing a count.
        return {
          total: null,
          hasMore: page?.isLast === false || !!page?.nextPageToken,
          issues,
        };
      }
      const total = n(page?.total);
      return { total, hasMore: total !== null && total > issues.length, issues };
    },
    async jira_get_issue({ issueKey, commentLimit }, signal) {
      const i = (await request(
        signal,
        'GET',
        issuePath(issueKey) + q({ fields: `${FIELDS},description,comment` }),
      )) as RawIssue;
      const comments = i.fields?.comment?.comments ?? [];
      return {
        ...brief(i),
        labels: Array.isArray(i.fields?.labels) ? i.fields.labels : [],
        description: s(i.fields?.description),
        comments: comments.slice(-commentLimit).map((c) => ({
          author: s(c.author?.displayName),
          body: s(c.body),
          created: s(c.created),
        })),
      };
    },
    async jira_get_transitions({ issueKey }, signal) {
      const r = (await request(signal, 'GET', `${issuePath(issueKey)}/transitions`)) as {
        transitions?: { id?: unknown; name?: unknown; to?: { name?: unknown } }[];
      };
      return {
        transitions: (r?.transitions ?? []).map((t) => ({
          id: s(t.id),
          name: s(t.name),
          to: s(t.to?.name),
        })),
      };
    },
    async jira_get_agile_boards({ projectKey }, signal) {
      const r = (await request(
        signal,
        'GET',
        `/rest/agile/1.0/board${q({ projectKeyOrId: projectKey, maxResults: 50 })}`,
      )) as { values?: { id?: unknown; name?: unknown; type?: unknown }[] };
      return {
        boards: (r?.values ?? []).map((b) => ({ id: n(b.id), name: s(b.name), type: s(b.type) })),
      };
    },
    async jira_get_sprints_from_board({ boardId, state, startAt, limit }, signal) {
      const r = (await request(
        signal,
        'GET',
        `/rest/agile/1.0/board/${boardId}/sprint${q({ state, startAt, maxResults: limit })}`,
      )) as { values?: Record<string, unknown>[]; isLast?: unknown };
      return {
        sprints: (r?.values ?? []).map((sp) => ({
          id: n(sp.id),
          name: s(sp.name),
          state: s(sp.state),
          startDate: s(sp.startDate),
          endDate: s(sp.endDate),
          goal: s(sp.goal),
        })),
        hasMore: r?.isLast === false,
      };
    },
    async jira_get_sprint_issues({ sprintId, limit }, signal) {
      const r = (await request(
        signal,
        'GET',
        `/rest/agile/1.0/sprint/${sprintId}/issue${q({ maxResults: limit, fields: FIELDS })}`,
      )) as { issues?: RawIssue[]; total?: unknown };
      const issues = (r?.issues ?? []).slice(0, limit).map(brief);
      const total = n(r?.total);
      return { total, hasMore: total !== null && total > issues.length, issues };
    },
    async jira_get_worklog({ issueKey }, signal) {
      return readWorklog(signal, issueKey);
    },
    async jira_worklog_summary(input, signal) {
      return summarizeWorklogs(input, {
        search: (jql, limit) =>
          handlers.jira_search({ jql, limit }, signal) as Promise<{
            hasMore: boolean;
            issues: { key: string | null; summary: string | null }[];
          }>,
        worklog: (key) => readWorklog(signal, key),
        signal,
      });
    },
    async jira_get_board_issues({ boardId, jql, limit }, signal) {
      const page = (await request(
        signal,
        'GET',
        `/rest/agile/1.0/board/${boardId}/issue${q({ jql, maxResults: limit, fields: FIELDS })}`,
      )) as { issues?: RawIssue[]; total?: unknown };
      const issues = (page?.issues ?? []).slice(0, limit).map(brief);
      const total = n(page?.total);
      return { total, hasMore: total !== null && total > issues.length, issues };
    },
    async jira_get_link_types(_input, signal) {
      const r = (await request(signal, 'GET', '/rest/api/2/issueLinkType')) as {
        issueLinkTypes?: unknown[];
      };
      return {
        linkTypes: (r?.issueLinkTypes ?? []).map((v) => {
          const t = (v ?? {}) as Record<string, unknown>;
          return { id: s(t.id), name: s(t.name), inward: s(t.inward), outward: s(t.outward) };
        }),
      };
    },
    async jira_get_project_versions({ projectKey }, signal) {
      const r = await request(
        signal,
        'GET',
        `/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`,
      );
      return {
        versions: (Array.isArray(r) ? r : []).map((v) => {
          const t = (v ?? {}) as Record<string, unknown>;
          return {
            id: s(t.id),
            name: s(t.name),
            released: typeof t.released === 'boolean' ? t.released : null,
            archived: typeof t.archived === 'boolean' ? t.archived : null,
            releaseDate: s(t.releaseDate),
            description: s(t.description),
          };
        }),
      };
    },
    async jira_get_project_components({ projectKey }, signal) {
      const r = await request(
        signal,
        'GET',
        `/rest/api/2/project/${encodeURIComponent(projectKey)}/components`,
      );
      return {
        components: (Array.isArray(r) ? r : []).map((v) => {
          const t = (v ?? {}) as Record<string, unknown>;
          const lead = (t.lead ?? {}) as Record<string, unknown>;
          return {
            id: s(t.id),
            name: s(t.name),
            description: s(t.description),
            lead: s(lead.displayName),
          };
        }),
      };
    },
    async jira_get_issue_watchers({ issueKey }, signal) {
      const r = (await request(signal, 'GET', `${issuePath(issueKey)}/watchers`)) as {
        watchCount?: unknown;
        watchers?: unknown[];
      };
      const watchers = (r?.watchers ?? []).flatMap((v) => {
        const name = s(((v ?? {}) as Record<string, unknown>).displayName);
        return name ? [name] : [];
      });
      return { issueKey, count: n(r?.watchCount) ?? watchers.length, watchers };
    },
    async jira_get_issue_dates() {
      throw new JiraToolError('not_supported');
    },
    async jira_get_project_epic_hierarchy() {
      throw new JiraToolError('not_supported');
    },
    async jira_get_cross_project_dependencies() {
      throw new JiraToolError('not_supported');
    },
    async jira_search_fields() {
      throw new JiraToolError('not_supported');
    },
    async jira_add_comment({ issueKey, body }, signal) {
      const c = (await request(signal, 'POST', `${issuePath(issueKey)}/comment`, {
        body: wiki(body),
      })) as {
        id?: unknown;
      };
      return { ok: true, issueKey, commentId: c?.id ?? null };
    },
    async jira_transition_issue({ issueKey, transitionId, comment }, signal) {
      await request(signal, 'POST', `${issuePath(issueKey)}/transitions`, {
        transition: { id: transitionId },
        ...(comment ? { update: { comment: [{ add: { body: wiki(comment) } }] } } : {}),
      });
      return { ok: true, issueKey, transitionId };
    },
    async jira_assign_issue({ issueKey, assignee }, signal) {
      const person = await findUser(signal, assignee);
      await request(
        signal,
        'PUT',
        `${issuePath(issueKey)}/assignee`,
        cloud ? { accountId: person.id } : { name: person.id },
      );
      return { ok: true, issueKey, assignee: person };
    },
    async jira_create_issue({ projectKey, summary, issueType, description }, signal) {
      const created = (await request(signal, 'POST', '/rest/api/2/issue', {
        fields: {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
          ...(description ? { description: wiki(description) } : {}),
        },
      })) as { key?: unknown };
      return { ok: true, key: s(created?.key) };
    },
    async jira_update_issue({ issueKey, summary, description, labels }, signal) {
      await request(signal, 'PUT', issuePath(issueKey), {
        fields: {
          ...(summary ? { summary } : {}),
          ...(description ? { description: wiki(description) } : {}),
          ...(labels ? { labels } : {}),
        },
      });
      return { ok: true, issueKey };
    },
  };

  return {
    kind: 'rest',
    async call(name, input, callOpts) {
      if (!isJiraToolName(name)) throw new JiraToolError('invalid_request');
      // One deadline for the whole call (a write may take several requests), plus the caller's.
      const signal = callSignal(opts.timeoutMs ?? 30_000, callOpts?.signal);
      if (signal.aborted) throw new JiraToolError('unavailable');
      return (handlers[name] as (i: typeof input, s: AbortSignal) => Promise<unknown>)(
        input,
        signal,
      );
    },
  };
}
