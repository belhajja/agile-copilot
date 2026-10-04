import { type JiraCredentials, ResponseTooLargeError, readCapped } from '@agile/jira';
import { createOutboundFetch, isBlockedAddressError, type OutboundPolicy } from '@agile/net';
import {
  codeForStatus,
  type JiraToolBackend,
  JiraToolError,
  type JiraUserCandidate,
} from './backend';
import type { JiraToolInput, JiraToolName } from './catalog';

type RestCredentials = Extract<JiraCredentials, { kind: 'cloud_basic' | 'datacenter_pat' }>;

const MAX_BODY = 5 * 1024 * 1024;
const FIELDS = 'summary,status,assignee,issuetype,updated,labels';

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

const s = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const brief = (i: RawIssue) => ({
  key: s(i.key),
  summary: s(i.fields?.summary),
  status: s(i.fields?.status?.name),
  assignee: s(i.fields?.assignee?.displayName),
  type: s(i.fields?.issuetype?.name),
  updated: s(i.fields?.updated),
});

/**
 * Jira tools over Jira's REST API with our own redirect-refusing, DNS-pinned client. Used for Cloud
 * API-token connections, which mcp-atlassian can only serve from one instance per site (see the
 * Phase 3 rulings), and by the e2e double. REST v2 everywhere: on Cloud it still takes and returns
 * plain-text bodies (no ADF), which keeps comments identical across deployments.
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

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
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
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new JiraToolError(isBlockedAddressError(e) ? 'blocked_url' : 'unavailable');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new JiraToolError(codeForStatus(res.status));
    }
    let text: string;
    try {
      // Counts bytes while streaming and aborts above the cap: a hostile Jira cannot make us buffer it.
      text = await readCapped(res, MAX_BODY);
    } catch (e) {
      throw new JiraToolError(e instanceof ResponseTooLargeError ? 'jira_error' : 'unavailable');
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new JiraToolError('jira_error');
    }
  }
  const q = (params: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
    return `?${sp}`;
  };
  const issuePath = (key: string) => `/rest/api/2/issue/${encodeURIComponent(key)}`;

  /**
   * The one active person whose account id, username, display name or email equals `identifier`
   * (case-insensitive). Never a fuzzy hit: the user approved this exact text. Anything else fails
   * with `ambiguous_user` (and up to 5 candidates, no emails) or `not_found`.
   */
  async function findUser(identifier: string): Promise<JiraUserCandidate> {
    const found = (await request(
      'GET',
      `/rest/api/2/user/search${q(cloud ? { query: identifier } : { username: identifier })}`,
    )) as unknown;
    const people = (Array.isArray(found) ? (found as RawUser[]) : []).flatMap((u) => {
      if (!u || typeof u !== 'object' || u.active === false) return [];
      // Cloud: app and customer (service desk) accounts are not assignable people.
      if (cloud && u.accountType !== undefined && u.accountType !== 'atlassian') return [];
      const id = s(cloud ? u.accountId : u.name);
      return id ? [{ user: u, person: { id, displayName: s(u.displayName) ?? id } }] : [];
    });
    const wanted = identifier.toLowerCase();
    const exact = people.filter(({ user }) =>
      [user.accountId, user.name, user.displayName, user.emailAddress].some(
        (v) => typeof v === 'string' && v.toLowerCase() === wanted,
      ),
    );
    const [only] = exact;
    if (only && exact.length === 1) return only.person;
    const candidates = (exact.length ? exact : people).slice(0, 5).map((p) => p.person);
    throw candidates.length
      ? new JiraToolError('ambiguous_user', { candidates })
      : new JiraToolError('not_found');
  }

  const handlers: { [N in JiraToolName]: (input: JiraToolInput<N>) => Promise<unknown> } = {
    async jira_search({ jql, limit }) {
      const path = cloud ? '/rest/api/3/search/jql' : '/rest/api/2/search';
      const page = (await request('GET', path + q({ jql, maxResults: limit, fields: FIELDS }))) as {
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
    async jira_get_issue({ issueKey, commentLimit }) {
      const i = (await request(
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
    async jira_get_transitions({ issueKey }) {
      const r = (await request('GET', `${issuePath(issueKey)}/transitions`)) as {
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
    async jira_get_agile_boards({ projectKey }) {
      const r = (await request(
        'GET',
        `/rest/agile/1.0/board${q({ projectKeyOrId: projectKey, maxResults: 50 })}`,
      )) as { values?: { id?: unknown; name?: unknown; type?: unknown }[] };
      return {
        boards: (r?.values ?? []).map((b) => ({ id: n(b.id), name: s(b.name), type: s(b.type) })),
      };
    },
    async jira_get_sprints_from_board({ boardId, state }) {
      const r = (await request(
        'GET',
        `/rest/agile/1.0/board/${boardId}/sprint${q({ state, maxResults: 50 })}`,
      )) as { values?: Record<string, unknown>[] };
      return {
        sprints: (r?.values ?? []).map((sp) => ({
          id: n(sp.id),
          name: s(sp.name),
          state: s(sp.state),
          startDate: s(sp.startDate),
          endDate: s(sp.endDate),
          goal: s(sp.goal),
        })),
      };
    },
    async jira_get_sprint_issues({ sprintId, limit }) {
      const r = (await request(
        'GET',
        `/rest/agile/1.0/sprint/${sprintId}/issue${q({ maxResults: limit, fields: FIELDS })}`,
      )) as { issues?: RawIssue[]; total?: unknown };
      const issues = (r?.issues ?? []).slice(0, limit).map(brief);
      const total = n(r?.total);
      return { total, hasMore: total !== null && total > issues.length, issues };
    },
    async jira_add_comment({ issueKey, body }) {
      const c = (await request('POST', `${issuePath(issueKey)}/comment`, { body })) as {
        id?: unknown;
      };
      return { ok: true, issueKey, commentId: c?.id ?? null };
    },
    async jira_transition_issue({ issueKey, transitionId, comment }) {
      await request('POST', `${issuePath(issueKey)}/transitions`, {
        transition: { id: transitionId },
        ...(comment ? { update: { comment: [{ add: { body: comment } }] } } : {}),
      });
      return { ok: true, issueKey, transitionId };
    },
    async jira_assign_issue({ issueKey, assignee }) {
      const person = await findUser(assignee);
      await request(
        'PUT',
        `${issuePath(issueKey)}/assignee`,
        cloud ? { accountId: person.id } : { name: person.id },
      );
      return { ok: true, issueKey, assignee: person };
    },
    async jira_create_issue({ projectKey, summary, issueType, description }) {
      const created = (await request('POST', '/rest/api/2/issue', {
        fields: {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
          ...(description ? { description } : {}),
        },
      })) as { key?: unknown };
      return { ok: true, key: s(created?.key) };
    },
    async jira_update_issue({ issueKey, summary, description, labels }) {
      await request('PUT', issuePath(issueKey), {
        fields: {
          ...(summary ? { summary } : {}),
          ...(description ? { description } : {}),
          ...(labels ? { labels } : {}),
        },
      });
      return { ok: true, issueKey };
    },
  };

  return {
    kind: 'rest',
    call: (name, input) => (handlers[name] as (i: typeof input) => Promise<unknown>)(input),
  };
}
