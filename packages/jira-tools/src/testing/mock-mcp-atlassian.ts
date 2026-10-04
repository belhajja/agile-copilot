import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkOutboundUrl, createOutboundFetch } from '@agile/net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { JiraToolError } from '../backend';
import { isJiraToolName, JIRA_TOOL_NAMES, JIRA_TOOLS, parseJiraToolInput } from '../catalog';
import { createRestJiraBackend } from '../rest-backend';

export interface MockMcpAtlassianOptions {
  /** Hosts the double accepts in X-Atlassian-Jira-Url even when private (like MCP_ALLOWED_URL_DOMAINS). */
  allowedHosts: readonly string[];
  /** Serve only the read tools of the catalog (like the read-only mcp-atlassian instance). */
  readOnly?: boolean;
}

export interface MockMcpAtlassian {
  url: string;
  /** Tool calls received, with the Jira URL they were for (never the token). */
  calls: { name: string; args: Record<string, unknown>; jiraUrl: string }[];
  close(): Promise<void>;
}

type Obj = Record<string, unknown>;
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const failure = (name: string, code: string) => ({
  content: [
    { type: 'text' as const, text: `Error calling tool '${name}': ${code.replace('_', ' ')}` },
  ],
  isError: true,
});

const reject = (res: ServerResponse, error: string) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

const mcpTime = (v: unknown) => {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime())
    ? `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`
    : v;
};

/** The REST backend's search result in mcp-atlassian 0.23.1's `jira_search` shape (Data Center). */
function mcpSearchResult(out: unknown, limit: unknown) {
  const r = out as { total: number | null; issues: Obj[] };
  return {
    total: r.total ?? -1,
    start_at: 0,
    max_results: typeof limit === 'number' ? limit : 10,
    issues: r.issues.map((i) => ({
      key: i.key,
      summary: i.summary,
      status: { name: i.status },
      // mcp-atlassian shows an unassigned issue as { display_name: 'Unassigned' } without ids.
      assignee:
        i.assignee === null
          ? { display_name: 'Unassigned' }
          : { display_name: i.assignee, name: i.assignee, account_id: null },
      issue_type: { name: i.type },
      // mcp-atlassian formats times as "YYYY-MM-DD HH:MM:SS <zone>" in its own zone (UTC here).
      updated: mcpTime(i.updated),
    })),
  };
}

/**
 * Test double for the shared mcp-atlassian instance (e2e and local development without Docker).
 * Same tool names and argument names as mcp-atlassian 0.23.1 for the enabled tools (the catalog
 * plus the backend-only `jira_search_assignable_users`), same per-request header contract for Data
 * Center PATs (credential-less requests get 401), mcp-atlassian's result shapes where the backend
 * reads them (search, transitions, assignable users, assignment), and the calls really reach Jira (the mock
 * Jira) through the REST backend. The contract test checks the real image against the same
 * expectations.
 */
export async function startMockMcpAtlassian(
  opts: MockMcpAtlassianOptions,
): Promise<MockMcpAtlassian> {
  const calls: MockMcpAtlassian['calls'] = [];
  const outbound = { allowedPrivateHosts: opts.allowedHosts };
  const outboundFetch = createOutboundFetch(outbound);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const jiraUrl = req.headers['x-atlassian-jira-url'];
    const token = req.headers['x-atlassian-jira-personal-token'];
    if (typeof jiraUrl !== 'string' || typeof token !== 'string' || !jiraUrl || !token) {
      reject(res, 'Authentication required: no Atlassian credentials were provided.');
      return;
    }
    const check = await checkOutboundUrl(jiraUrl, { allowedPrivateHosts: opts.allowedHosts });
    if (!check.ok) {
      reject(res, 'Forbidden: Invalid Jira URL');
      return;
    }
    const backend = createRestJiraBackend(
      { kind: 'datacenter_pat', baseUrl: jiraUrl, token },
      { outbound },
    );
    const server = new McpServer({ name: 'mock-mcp-atlassian', version: '0.23.1' });
    for (const name of JIRA_TOOL_NAMES) {
      if (opts.readOnly && JIRA_TOOLS[name].write) continue;
      server.registerTool(
        name,
        { description: JIRA_TOOLS[name].description, inputSchema: z.looseObject({}) },
        async (args: Obj) => {
          calls.push({ name, args, jiraUrl });
          let mcpArgs = args;
          if (name === 'jira_assign_issue' && typeof args.assignee === 'string') {
            // Like mcp-atlassian: a JSON object assigns that exact id (name on Data Center).
            try {
              const parsed = JSON.parse(args.assignee) as Obj;
              mcpArgs = { ...args, assignee: parsed.name ?? parsed.accountId };
            } catch {}
          }
          const parsed = parseJiraToolInput(
            name,
            (JIRA_TOOLS[name].fromMcp as (a: Obj) => unknown)(mcpArgs),
          );
          if (!parsed.success || !isJiraToolName(name)) {
            return { content: [{ type: 'text', text: 'Invalid arguments' }], isError: true };
          }
          try {
            const out = await backend.call(name, parsed.data as never);
            if (name === 'jira_search') return text(mcpSearchResult(out, args.limit));
            if (name === 'jira_get_transitions') {
              // mcp-atlassian 0.23.1: a bare list, integer ids, no target status against Jira.
              const { transitions } = out as { transitions: { id: string; name: string }[] };
              return text(transitions.map((t) => ({ id: Number(t.id), name: t.name })));
            }
            if (name === 'jira_assign_issue') {
              const who = (out as { assignee: { id: string; displayName: string } }).assignee;
              return text({
                message: `Issue ${String(args.issue_key)} assigned successfully`,
                issue: {
                  key: args.issue_key,
                  assignee: { display_name: who.displayName, name: who.id },
                },
              });
            }
            return text(out);
          } catch (e) {
            return failure(name, e instanceof JiraToolError ? e.code : 'jira_error');
          }
        },
      );
    }
    if (!opts.readOnly) {
      // Backend-only lookup (never offered to the model): GET /user/assignable/search, simplified
      // like mcp-atlassian's JiraUser.to_simplified_dict (no `active`, no `accountType`).
      server.registerTool(
        'jira_search_assignable_users',
        {
          description: 'Search Jira users assignable in a project or issue.',
          inputSchema: z.looseObject({}),
        },
        async (args: Obj) => {
          calls.push({ name: 'jira_search_assignable_users', args, jiraUrl });
          const sp = new URLSearchParams({
            username: String(args.query ?? ''),
            maxResults: String(args.limit ?? 20),
            ...(typeof args.issue_key === 'string' ? { issueKey: args.issue_key } : {}),
            ...(typeof args.project_key === 'string' ? { project: args.project_key } : {}),
          });
          try {
            const res = await outboundFetch(
              new URL(`${jiraUrl.replace(/\/+$/, '')}/rest/api/2/user/assignable/search?${sp}`),
              { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) {
              await res.body?.cancel();
              // mcp-atlassian answers lookup failures with success: false and the requests error
              // text, whose status the backend reads back as `codeForStatus(status)`.
              const kind = res.status < 500 ? 'Client' : 'Server';
              return text({
                success: false,
                error: `${res.status} ${kind} Error`,
                query: args.query,
              });
            }
            const users = ((await res.json()) as Obj[]).map((u) => ({
              account_id: u.accountId ?? null,
              display_name: u.displayName,
              name: u.name ?? u.displayName,
              email: u.emailAddress ?? null,
              avatar_url: null,
              ...(u.key ? { key: u.key } : {}),
            }));
            return text({ success: true, count: users.length, users });
          } catch {
            // Jira unreachable: the text names the code the backend maps it to.
            return text({
              success: false,
              error: 'Connection refused: unavailable',
              query: args.query,
            });
          }
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
