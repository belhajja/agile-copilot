import type { JiraCredentials } from '@agile/jira';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  callSignal,
  isoTime,
  type JiraToolBackend,
  JiraToolError,
  type JiraToolErrorCode,
  type JiraUserCandidate,
} from './backend';
import { isJiraToolName, JIRA_TOOL_NAMES, JIRA_TOOLS, type JiraToolInput } from './catalog';

export type McpCredentials = Extract<JiraCredentials, { kind: 'datacenter_pat' | 'cloud_oauth' }>;

/**
 * mcp-atlassian tools the backend calls itself and the model never sees (they are not in the
 * catalog). `jira_search_assignable_users` resolves an assignee exactly before any assignment.
 */
export const MCP_ATLASSIAN_BACKEND_ONLY_TOOLS: readonly string[] = Object.freeze([
  'jira_search_assignable_users',
]);
/** The deployment's `ENABLED_TOOLS` for the read-write mcp-atlassian instance. */
export const MCP_ATLASSIAN_ENABLED_TOOLS: readonly string[] = Object.freeze([
  ...JIRA_TOOL_NAMES,
  ...MCP_ATLASSIAN_BACKEND_ONLY_TOOLS,
]);

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
 * mcp-atlassian's `jira_search` result → the REST backend's `{ total, hasMore, issues }`. On Cloud
 * mcp-atlassian reports `total: -1` (the v3 API has no count) and a `next_page_token` instead.
 */
export function searchFromMcp(raw: unknown, limit: number) {
  const r = obj(raw);
  const total = typeof r.total === 'number' && r.total >= 0 ? r.total : null;
  const start = typeof r.start_at === 'number' && r.start_at > 0 ? r.start_at : 0;
  const issues = (Array.isArray(r.issues) ? r.issues : []).slice(0, limit).map((v) => {
    const i = obj(v);
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
    };
  });
  return {
    total,
    hasMore: total !== null ? total > start + issues.length : !!r.next_page_token,
    issues,
  };
}

/**
 * mcp-atlassian's `jira_get_transitions` result (a bare list, numeric ids, and against Jira no
 * target status) → the REST backend's `{ transitions: [{ id, name, to }] }`, with string ids the
 * model can send back as `jira_transition_issue` input.
 */
export function transitionsFromMcp(raw: unknown) {
  return {
    transitions: (Array.isArray(raw) ? raw : []).map((v) => {
      const t = obj(v);
      return {
        id: typeof t.id === 'number' ? String(t.id) : s(t.id),
        name: s(t.name),
        to: s(t.to_status),
      };
    }),
  };
}

/**
 * Calls allowlisted tools on mcp-atlassian, one MCP client per backend call (it builds a new Jira
 * client per request anyway), with a deadline. Input is mapped with the catalog's `toMcp`; errors
 * become codes. Credentials travel only in the request headers and never in errors.
 */
export function createMcpAtlassianBackend(
  creds: McpCredentials,
  opts: { url: string; timeoutMs?: number },
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
   * The one assignable person whose account id, username, display name or email equals
   * `identifier` (case-insensitive), as the REST backend does (ruling P3-R17). Jira's assignable
   * search only returns active users who can be assigned this issue. mcp-atlassian's own matching
   * (first hit, then a permission search) is never used: we assign by id.
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
      return id ? [{ user: u, person: { id, displayName: s(u.display_name) ?? id } }] : [];
    });
    const wanted = identifier.toLowerCase();
    const exact = people.filter(({ user }) =>
      [user.account_id, user.name, user.display_name, user.email].some(
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
      });
      try {
        await client.connect(transport, { signal, timeout });
        if (name === 'jira_assign_issue') {
          const { issueKey, assignee } = input as JiraToolInput<'jira_assign_issue'>;
          const person = await findAssignee(client, signal, issueKey, assignee);
          // A JSON object makes mcp-atlassian assign this exact id, without its own lookup.
          await callText(client, signal, name, {
            issue_key: issueKey,
            assignee: JSON.stringify(cloud ? { accountId: person.id } : { name: person.id }),
          });
          return { ok: true, issueKey, assignee: person };
        }
        const out = await callText(
          client,
          signal,
          name,
          (JIRA_TOOLS[name].toMcp as (i: typeof input) => Obj)(input),
        );
        if (name === 'jira_search') {
          return searchFromMcp(out, (input as JiraToolInput<'jira_search'>).limit);
        }
        if (name === 'jira_get_transitions') return transitionsFromMcp(out);
        return out;
      } catch (e) {
        if (e instanceof JiraToolError) throw e;
        throw new JiraToolError(codeFromError(e));
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
