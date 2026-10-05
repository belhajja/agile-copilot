import { type JiraCredentials, readCapped } from '@agile/jira';
import { createOutboundFetch, fetchNoRedirect, type OutboundPolicy } from '@agile/net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  callSignal,
  exactPerson,
  isoTime,
  type JiraToolBackend,
  JiraToolError,
  type JiraToolErrorCode,
  type JiraUserCandidate,
} from './backend';
import {
  isJiraToolName,
  JIRA_LOCAL_TOOLS,
  JIRA_TOOL_NAMES,
  JIRA_TOOLS,
  type JiraToolInput,
} from './catalog';
import {
  type TimeTrackingConfig,
  timeTrackingConfigFrom,
  timeTrackingFromMcp,
} from './time-tracking';
import { summarizeWorklogs, type Worklog, worklogEntry, worklogOf } from './worklog-summary';

export type McpCredentials = Extract<JiraCredentials, { kind: 'datacenter_pat' | 'cloud_oauth' }>;

/**
 * mcp-atlassian tools the backend calls itself and the model never sees (they are not in the
 * catalog). `jira_search_assignable_users` resolves an assignee exactly before any assignment.
 */
export const MCP_ATLASSIAN_BACKEND_ONLY_TOOLS: readonly string[] = Object.freeze([
  'jira_search_assignable_users',
]);
/** The deployment's `ENABLED_TOOLS` for the read-write mcp-atlassian instance (our local tools excluded). */
export const MCP_ATLASSIAN_ENABLED_TOOLS: readonly string[] = Object.freeze([
  ...JIRA_TOOL_NAMES.filter((n) => !JIRA_LOCAL_TOOLS.has(n)),
  ...MCP_ATLASSIAN_BACKEND_ONLY_TOOLS,
]);
/**
 * The deployment's `ENABLED_TOOLS` for the read-only twin (scheduled/background runs): the
 * catalog's read tools only, with `READ_ONLY_MODE=true` on the instance as a second guard.
 */
export const MCP_ATLASSIAN_READONLY_ENABLED_TOOLS: readonly string[] = Object.freeze(
  JIRA_TOOL_NAMES.filter((n) => !JIRA_TOOLS[n].write && !JIRA_LOCAL_TOOLS.has(n)),
);

/**
 * Per-request credentials for the shared mcp-atlassian instance (spec: "Jira auth & MCP topology").
 * Data Center: Jira URL + PAT headers. Cloud OAuth: the user's bearer token + cloud id (the
 * instance runs with ATLASSIAN_OAUTH_ENABLE=true). Nothing tenant-specific is configured on the
 * instance itself, so every request carries its own tenant's credentials and nothing else.
 */
export function mcpAtlassianHeaders(creds: McpCredentials): Record<string, string> {
  return creds.kind === 'datacenter_pat'
    ? { 'X-Atlassian-Jira-Url': creds.baseUrl, 'X-Atlassian-Jira-Personal-Token': creds.token }
    : { Authorization: `Bearer ${creds.accessToken}`, 'X-Atlassian-Cloud-Id': creds.cloudId };
}

/** mcp-atlassian reports Jira failures as text; keep only a stable code. */
export function codeFromToolText(text: string): JiraToolErrorCode {
  if (/\bunavailable\b|connection refused|max retries exceeded|timed out/i.test(text))
    return 'unavailable';
  // Includes mcp-atlassian 0.23.1's own user-resolution failures (users.py).
  if (
    /\b404\b|not found|does not exist|could not find|could not resolve|could not determine how to look up/i.test(
      text,
    )
  )
    return 'not_found';
  if (/\b401\b|unauthori[sz]ed|invalid header-based|authentication/i.test(text))
    return 'unauthorized';
  if (/\b403\b|forbidden|permission/i.test(text)) return 'forbidden';
  if (/\b429\b|rate limit/i.test(text)) return 'rate_limited';
  if (/\b400\b|invalid|required/i.test(text)) return 'invalid_request';
  return 'jira_error';
}

/** Transport failures: the instance refused the credentials, or could not be reached. */
function codeFromError(e: unknown): JiraToolErrorCode {
  const status = (e as { code?: unknown }).code;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  return 'unavailable';
}

/** The MCP SDK's own per-request timeout (it fires with the same total as the call's deadline). */
const isRequestTimeout = (e: unknown) =>
  e instanceof McpError && e.code === ErrorCode.RequestTimeout;

const parseText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const s = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * One mcp-atlassian issue (`JiraIssue.to_simplified_dict`) → the REST backend's brief fields: key,
 * summary, status, assignee (display name only), type, updated (ISO), timeTracking. Shared by
 * `searchFromMcp` (search, board and sprint issues) and `issueFromMcp` (a single issue): both
 * mcp-atlassian tools answer with the same per-issue shape.
 */
function briefFromMcp(raw: unknown, config: TimeTrackingConfig | null) {
  const i = obj(raw);
  const a = obj(i.assignee);
  // Unassigned issues come back as { display_name: 'Unassigned' } without any id.
  const assigned = 'account_id' in a || 'name' in a || 'key' in a;
  return {
    key: s(i.key),
    summary: s(i.summary),
    status: s(obj(i.status).name),
    assignee: assigned ? s(a.display_name) : null,
    type: s(obj(i.issue_type).name),
    updated: isoTime(i.updated),
    timeTracking: timeTrackingFromMcp(i.timetracking, config),
  };
}

/**
 * mcp-atlassian's `jira_search` result → the REST backend's `{ total, hasMore, issues }`. On Cloud
 * mcp-atlassian reports `total: -1` (the v3 API has no count) and a `next_page_token` instead.
 * Also used for `jira_get_board_issues` and `jira_get_sprint_issues`: 0.23.1 answers all three with
 * the same `JiraSearchResult.to_simplified_dict()` shape.
 */
export function searchFromMcp(
  raw: unknown,
  limit: number,
  config: TimeTrackingConfig | null = null,
) {
  const r = obj(raw);
  const total = typeof r.total === 'number' && r.total >= 0 ? r.total : null;
  const start = typeof r.start_at === 'number' && r.start_at > 0 ? r.start_at : 0;
  const issues = (Array.isArray(r.issues) ? r.issues : [])
    .slice(0, limit)
    .map((v) => briefFromMcp(v, config));
  return {
    total,
    hasMore: total !== null ? total > start + issues.length : !!r.next_page_token,
    issues,
  };
}

/**
 * mcp-atlassian's `jira_get_issue` result → the REST backend's `jira_get_issue` shape exactly: the
 * brief fields (see `briefFromMcp`) plus `labels`, `description` and `comments` (author reduced to
 * a display name). mcp-atlassian's raw issue also carries `reporter` and, on each comment, a full
 * `JiraUser.to_simplified_dict()` author (`account_id`/`name`/`email`): neither is read here, so
 * neither reaches the model.
 */
export function issueFromMcp(raw: unknown, config: TimeTrackingConfig | null) {
  const i = obj(raw);
  const comments = Array.isArray(i.comments) ? i.comments : [];
  return {
    ...briefFromMcp(i, config),
    labels: Array.isArray(i.labels) ? i.labels : [],
    description: s(i.description),
    comments: comments.map((v) => {
      const c = obj(v);
      return { author: s(obj(c.author).display_name), body: s(c.body), created: s(c.created) };
    }),
  };
}

/**
 * mcp-atlassian 0.23.1's `jira_get_worklog` result → the REST backend's `Worklog`
 * (`WorklogMixin.get_worklogs`: `author` is already the plain display-name string Jira returned,
 * falling back to the literal "Unknown" when Jira had none; `started` is `str(parse_date(...))` —
 * space-separated with a colon offset, or the literal "None" when nothing parsed).
 */
export function worklogFromMcp(issueKey: string, raw: unknown): Worklog {
  const list = obj(raw).worklogs;
  const entries = (Array.isArray(list) ? list : []).flatMap((v) => {
    const w = obj(v);
    const author = s(w.author);
    const e = worklogEntry({
      author: author === 'Unknown' ? null : author,
      started: isoTime(w.started),
      seconds: w.time_spent_seconds,
      comment: w.comment,
    });
    return e ? [e] : [];
  });
  return worklogOf(issueKey, entries, false);
}

/**
 * mcp-atlassian 0.23.1's `jira_get_issue_watchers` result (`JiraUser.to_simplified_dict`) → the
 * REST backend's `{ issueKey, count, watchers }`. Display names only: no email, account id or
 * username.
 */
export function watchersFromMcp(issueKey: string, raw: unknown) {
  const r = obj(raw);
  const watchers = (Array.isArray(r.watchers) ? r.watchers : []).flatMap((v) => {
    const name = s(obj(v).display_name);
    return name ? [name] : [];
  });
  return {
    issueKey,
    count: typeof r.watcher_count === 'number' ? r.watcher_count : watchers.length,
    watchers,
  };
}

/**
 * mcp-atlassian 0.23.1's `jira_get_link_types` result (a bare array, `JiraIssueLinkType.
 * to_simplified_dict`) → the REST backend's `{ linkTypes }`.
 */
export function linkTypesFromMcp(raw: unknown) {
  return {
    linkTypes: (Array.isArray(raw) ? raw : []).map((v) => {
      const t = obj(v);
      return { id: s(t.id), name: s(t.name), inward: s(t.inward), outward: s(t.outward) };
    }),
  };
}

/**
 * mcp-atlassian 0.23.1's `jira_get_project_versions` result (a bare array, `JiraVersion.
 * to_simplified_dict`) → the REST backend's `{ versions }`.
 */
export function versionsFromMcp(raw: unknown) {
  return {
    versions: (Array.isArray(raw) ? raw : []).map((v) => {
      const t = obj(v);
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
}

/**
 * mcp-atlassian 0.23.1's `jira_get_project_components` result (a bare array of Jira's own
 * component fields, unprocessed) → the REST backend's `{ components }` (the lead reduced to a
 * display name).
 */
export function componentsFromMcp(raw: unknown) {
  return {
    components: (Array.isArray(raw) ? raw : []).map((v) => {
      const t = obj(v);
      const lead = obj(t.lead);
      return {
        id: s(t.id),
        name: s(t.name),
        description: s(t.description),
        lead: s(lead.displayName),
      };
    }),
  };
}

/**
 * mcp-atlassian's `jira_get_transitions` result (a bare list, numeric ids, and against Jira no
 * target status) → the REST backend's `{ transitions: [{ id, name, to }] }`, with string ids the
 * model can send back as `jira_transition_issue` input. A `{ transitions: [...] }` wrapper is read
 * too; any other result is a failure (`jira_error`), never "no transitions".
 */
export function transitionsFromMcp(raw: unknown) {
  const list = Array.isArray(raw) ? raw : obj(raw).transitions;
  if (!Array.isArray(list)) throw new JiraToolError('jira_error');
  return {
    transitions: list.map((v) => {
      const t = obj(v);
      return {
        id: typeof t.id === 'number' ? String(t.id) : s(t.id),
        name: s(t.name),
        to: s(t.to_status),
      };
    }),
  };
}

/** A definitive answer (2xx parsed, or 404/405 meaning no such endpoint) is good for an hour. */
const SETTING_TTL_MS = 60 * 60 * 1000;
/**
 * Any other failure (a bad PAT, a network blip, a deadline) is retried much sooner: it may be
 * transient or specific to one user's credentials, unlike a definitive answer.
 */
const SETTING_FAILURE_TTL_MS = 5 * 60 * 1000;
const settings = new Map<string, { config: TimeTrackingConfig | null; at: number; ttl: number }>();

/** Test-only: clears the working-time cache so one test's cached answer cannot leak into another's. */
export function resetWorkingTimeCacheForTests(): void {
  settings.clear();
}

/**
 * The instance's working-time setting (hours per day, days per week), read with the connection's
 * own credentials and cached per Jira. mcp-atlassian does not expose it, and its time-tracking
 * output is display text only. Any failure gives null: hours are then left unknown rather than
 * guessed. A definitive answer is cached for an hour; anything else (including a usable 2xx that
 * says time tracking is disabled) only for 5 minutes, keyed only by the Jira base — so one user's
 * bad PAT or a passing network blip doesn't blank hours for everyone on that Jira for long. An
 * aborted attempt is never cached at all: it proves nothing about the Jira itself.
 */
export async function workingTime(
  creds: McpCredentials,
  opts: { outbound?: OutboundPolicy; atlassianApiBase?: string },
  signal: AbortSignal,
): Promise<TimeTrackingConfig | null> {
  if (!opts.outbound) return null;
  const base =
    creds.kind === 'datacenter_pat'
      ? creds.baseUrl.replace(/\/+$/, '')
      : `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${creds.cloudId}`;
  const cached = settings.get(base);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.config;
  let config: TimeTrackingConfig | null = null;
  let ttl = SETTING_FAILURE_TTL_MS;
  try {
    const res = await createOutboundFetch(opts.outbound)(
      new URL(`${base}/rest/api/2/configuration`),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${creds.kind === 'datacenter_pat' ? creds.token : creds.accessToken}`,
        },
        signal,
      },
    );
    if (res.ok) {
      config = timeTrackingConfigFrom(JSON.parse(await readCapped(res, 64 * 1024)));
      ttl = SETTING_TTL_MS;
    } else {
      await res.body?.cancel();
      // No such endpoint on this Jira: a stable, definitive answer, not a transient failure.
      if (res.status === 404 || res.status === 405) ttl = SETTING_TTL_MS;
    }
  } catch {
    config = null;
  }
  if (signal.aborted) return null;
  settings.set(base, { config, at: Date.now(), ttl });
  return config;
}

/**
 * Calls allowlisted tools on mcp-atlassian, one MCP client per backend call (it builds a new Jira
 * client per request anyway), with a deadline. Input is mapped with the catalog's `toMcp`; errors
 * become codes. Credentials travel only in the request headers and never in errors.
 */
export function createMcpAtlassianBackend(
  creds: McpCredentials,
  opts: { url: string; timeoutMs?: number; outbound?: OutboundPolicy; atlassianApiBase?: string },
): JiraToolBackend {
  const timeout = opts.timeoutMs ?? 30_000;
  const cloud = creds.kind === 'cloud_oauth';

  async function callText(
    client: Client,
    signal: AbortSignal,
    name: string,
    args: Obj,
  ): Promise<unknown> {
    // `signal` carries the call's one deadline; the SDK's per-request timeout is set to the same
    // total so that it never cuts a request short on its own.
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout,
    });
    const text = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (result.isError) throw new JiraToolError(codeFromToolText(text));
    return parseText(text);
  }

  /**
   * The one assignable person `identifier` names exactly, as the REST backend does (see
   * `exactPerson`). Jira's assignable search only returns active users who can be assigned this
   * issue. mcp-atlassian's own matching (first hit, then a permission search) is never used: we
   * assign by id.
   */
  async function findAssignee(
    client: Client,
    signal: AbortSignal,
    issueKey: string,
    identifier: string,
  ): Promise<JiraUserCandidate> {
    const found = obj(
      await callText(client, signal, 'jira_search_assignable_users', {
        query: identifier,
        issue_key: issueKey,
        limit: 50,
      }),
    );
    if (found.success !== true) {
      throw new JiraToolError(codeFromToolText(s(found.error) ?? ''));
    }
    const people = (Array.isArray(found.users) ? found.users : []).flatMap((v) => {
      const u = obj(v);
      const id = s(cloud ? u.account_id : u.name);
      return id
        ? [
            {
              person: { id, displayName: s(u.display_name) ?? id },
              keys: [u.account_id, u.name, u.display_name, u.email],
              active: u.active,
              accountType: u.account_type,
            },
          ]
        : [];
    });
    return exactPerson(people, identifier, { cloud });
  }

  return {
    kind: 'mcp-atlassian',
    async call(name, input, callOpts) {
      // Only catalog tools: the backend-only lookup is never callable through here.
      if (!isJiraToolName(name)) throw new JiraToolError('invalid_request');
      // One deadline for the whole call: connect, and for an assignment lookup + assign.
      const signal = callSignal(timeout, callOpts?.signal);
      if (signal.aborted) throw new JiraToolError('unavailable');
      const client = new Client({ name: 'agile-copilot', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
        requestInit: { headers: mcpAtlassianHeaders(creds) },
        // Never follow a redirect, not even within the origin: the headers carry Jira credentials.
        fetch: fetchNoRedirect,
      });
      // Set once the write's own request is on its way: a cut-off after that may have reached Jira.
      let writeSent = false;
      const write = JIRA_TOOLS[name].write;
      try {
        await client.connect(transport, { signal, timeout });
        if (name === 'jira_assign_issue') {
          const { issueKey, assignee } = input as JiraToolInput<'jira_assign_issue'>;
          const person = await findAssignee(client, signal, issueKey, assignee);
          // A JSON object makes mcp-atlassian assign this exact id, without its own lookup.
          writeSent = true;
          await callText(client, signal, name, {
            issue_key: issueKey,
            assignee: JSON.stringify(cloud ? { accountId: person.id } : { name: person.id }),
          });
          return { ok: true, issueKey, assignee: person };
        }
        if (name === 'jira_worklog_summary') {
          return await summarizeWorklogs(input as JiraToolInput<'jira_worklog_summary'>, {
            search: async (jql, limit) =>
              searchFromMcp(
                await callText(
                  client,
                  signal,
                  'jira_search',
                  JIRA_TOOLS.jira_search.toMcp({ jql, limit }),
                ),
                limit,
              ),
            worklog: async (key) =>
              worklogFromMcp(
                key,
                await callText(client, signal, 'jira_get_worklog', { issue_key: key }),
              ),
            signal,
          });
        }
        // Our own tools stop here: everything past this point is sent to mcp-atlassian as-is.
        if (JIRA_LOCAL_TOOLS.has(name)) throw new JiraToolError('not_supported');
        writeSent = write;
        const out = await callText(
          client,
          signal,
          name,
          (JIRA_TOOLS[name].toMcp as (i: typeof input) => Obj)(input),
        );
        const config =
          /^(jira_search|jira_get_issue|jira_get_sprint_issues|jira_get_board_issues)$/.test(name)
            ? await workingTime(creds, opts, signal)
            : null;
        if (name === 'jira_search') {
          return searchFromMcp(out, (input as JiraToolInput<'jira_search'>).limit, config);
        }
        if (name === 'jira_get_board_issues') {
          return searchFromMcp(
            out,
            (input as JiraToolInput<'jira_get_board_issues'>).limit,
            config,
          );
        }
        if (name === 'jira_get_issue') return issueFromMcp(out, config);
        if (name === 'jira_get_sprint_issues') {
          return searchFromMcp(
            out,
            (input as JiraToolInput<'jira_get_sprint_issues'>).limit,
            config,
          );
        }
        if (name === 'jira_get_worklog') {
          return worklogFromMcp((input as JiraToolInput<'jira_get_worklog'>).issueKey, out);
        }
        if (name === 'jira_get_issue_watchers') {
          return watchersFromMcp((input as JiraToolInput<'jira_get_issue_watchers'>).issueKey, out);
        }
        if (name === 'jira_get_link_types') return linkTypesFromMcp(out);
        if (name === 'jira_get_project_versions') return versionsFromMcp(out);
        if (name === 'jira_get_project_components') return componentsFromMcp(out);
        if (name === 'jira_get_transitions') return transitionsFromMcp(out);
        return out;
      } catch (e) {
        if (e instanceof JiraToolError) throw e;
        const code = codeFromError(e);
        // Once the write's request is on its way, a cut-off (deadline, abort, reset connection,
        // unreadable answer) may have reached Jira. Only the instance refusing the credentials
        // proves it did not run (P3 #43).
        if (writeSent && (code === 'unavailable' || signal.aborted || isRequestTimeout(e))) {
          throw new JiraToolError('unknown_outcome');
        }
        throw new JiraToolError(code);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
