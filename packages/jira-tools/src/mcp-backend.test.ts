import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { demoDataset, type MockJira, startMockJira } from '@agile/jira/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { codeForStatus, type JiraToolBackend, JiraToolError } from './backend';
import { isJiraToolName, JIRA_TOOL_NAMES, type JiraToolName, parseJiraToolInput } from './catalog';
import { createJiraToolBackend } from './index';
import {
  codeFromToolText,
  createMcpAtlassianBackend,
  MCP_ATLASSIAN_BACKEND_ONLY_TOOLS,
  MCP_ATLASSIAN_ENABLED_TOOLS,
  mcpAtlassianHeaders,
  searchFromMcp,
  transitionsFromMcp,
} from './mcp-backend';
import { createRestJiraBackend } from './rest-backend';
import { type MockMcpAtlassian, startMockMcpAtlassian } from './testing/mock-mcp-atlassian';
import { ANCHOR, EXPECTED_WRITES, exercise, outbound, run } from './testing/scenario';

describe('mcp-atlassian backend through the double', () => {
  let dc: MockJira;
  let double: MockMcpAtlassian;
  beforeAll(async () => {
    dc = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer good-pat',
      dataset: demoDataset(ANCHOR),
      extraUsers: [
        { accountId: 'u-alexandra', name: 'alexandra', displayName: 'Alexandra Petit' },
        { accountId: 'u-old', name: 'old.timer', displayName: 'Old Timer', active: false },
      ],
    });
    double = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'] });
  });
  afterAll(async () => {
    await Promise.all([dc?.close(), double?.close()]);
  });
  const backend = () =>
    createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
      { url: double.url },
    );

  it('mcp-atlassian backend (Data Center PAT) through the double', async () => {
    const r = await exercise(backend(), dc);
    expect(r.writes).toEqual(EXPECTED_WRITES);
    expect(dc.writes[0]).toMatchObject({
      body: { body: 'Blocked by the *API* team:\n* {{npm ci}} fails' },
      authorization: 'Bearer good-pat',
    });
    expect(double.calls.at(0)).toMatchObject({ name: 'jira_search', jiraUrl: dc.url });
  });

  it('maps Jira and transport failures to codes', async () => {
    await expect(run(backend(), 'jira_get_issue', { issueKey: 'NOPE-1' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const wrongToken = createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'bad' },
      { url: double.url },
    );
    await expect(run(wrongToken, 'jira_get_issue', { issueKey: 'DEMO-1' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const blocked = createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: 'http://10.0.0.8/jira', token: 'good-pat' },
      { url: double.url },
    );
    await expect(run(blocked, 'jira_get_issue', { issueKey: 'DEMO-1' })).rejects.toBeInstanceOf(
      JiraToolError,
    );
    const down = createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
      { url: 'http://127.0.0.1:9/mcp', timeoutMs: 2_000 },
    );
    await expect(run(down, 'jira_get_issue', { issueKey: 'DEMO-1' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('lists transitions like the REST backend, with string ids', async () => {
    // mcp-atlassian 0.23.1 answers a bare list with numeric ids and no target status (the double
    // does the same); the model must get ids it can send back as jira_transition_issue input.
    const viaMcp = await run(backend(), 'jira_get_transitions', { issueKey: 'DEMO-1' });
    const viaRest = (await run(
      createRestJiraBackend(
        { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
        { outbound },
      ),
      'jira_get_transitions',
      { issueKey: 'DEMO-1' },
    )) as { transitions: { id: string; name: string; to: string | null }[] };
    expect(viaMcp).toEqual({
      transitions: viaRest.transitions.map((t) => ({ ...t, to: null })),
    });
    expect(viaRest.transitions[1]).toMatchObject({ id: '21', name: 'In Progress' });
    expect(transitionsFromMcp([{ id: 21, name: 'In Progress', to_status: 'In Progress' }])).toEqual(
      { transitions: [{ id: '21', name: 'In Progress', to: 'In Progress' }] },
    );
    // A `{ transitions }` wrapper is read too; anything else is a Jira-side failure, not "none".
    expect(transitionsFromMcp({ transitions: [{ id: '31', name: 'Done' }] })).toEqual({
      transitions: [{ id: '31', name: 'Done', to: null }],
    });
    for (const raw of ['not json', null, { message: 'x' }, { transitions: 'x' }]) {
      expect(() => transitionsFromMcp(raw)).toThrow(
        expect.objectContaining({ code: 'jira_error' }),
      );
    }
  });

  it('returns the same search shape as the REST backend', async () => {
    const viaMcp = await run(backend(), 'jira_search', { jql: 'filter = 101', limit: 3 });
    const viaRest = await run(
      createRestJiraBackend(
        { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
        { outbound },
      ),
      'jira_search',
      { jql: 'filter = 101', limit: 3 },
    );
    expect(viaMcp).toEqual(viaRest);
    expect(viaMcp).toMatchObject({ total: expect.any(Number), hasMore: true });
    expect((viaMcp as { issues: unknown[] }).issues).toHaveLength(3);
  });

  it('assigns only the one active person matching exactly, resolved before the write', async () => {
    double.calls.length = 0;
    dc.writes.length = 0;
    await expect(
      run(backend(), 'jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'ALEX' }),
    ).resolves.toEqual({
      ok: true,
      issueKey: 'DEMO-2',
      assignee: { id: 'alex', displayName: 'Alex Martin' },
    });
    // The backend looks the person up itself, then assigns by id: mcp-atlassian does no matching.
    expect(double.calls.map((c) => [c.name, c.args])).toEqual([
      ['jira_search_assignable_users', { query: 'ALEX', issue_key: 'DEMO-2', limit: 50 }],
      ['jira_assign_issue', { issue_key: 'DEMO-2', assignee: '{"name":"alex"}' }],
    ]);
    expect(dc.writes).toMatchObject([
      { method: 'PUT', path: '/rest/api/2/issue/DEMO-2/assignee', body: { name: 'alex' } },
    ]);

    dc.writes.length = 0;
    const ambiguous = await run(backend(), 'jira_assign_issue', {
      issueKey: 'DEMO-2',
      assignee: 'Ale',
    }).catch((e: unknown) => e);
    expect(ambiguous).toBeInstanceOf(JiraToolError);
    expect((ambiguous as JiraToolError).message).toBe('Jira tool failed: ambiguous_user');
    expect((ambiguous as JiraToolError).toData()).toEqual({
      error: 'ambiguous_user',
      candidates: [
        { id: 'alex', displayName: 'Alex Martin' },
        { id: 'alexandra', displayName: 'Alexandra Petit' },
      ],
    });
    // Deactivated people are not assignable; nobody → not_found. Nothing was written.
    for (const assignee of ['Old Timer', 'Nobody']) {
      await expect(
        run(backend(), 'jira_assign_issue', { issueKey: 'DEMO-2', assignee }),
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(dc.writes).toEqual([]);
  });

  it('never puts credentials in errors, logs, tool output or the double’s records', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    try {
      const secrets = ['good-pat', 'bad-SECRET-pat', 'oauth-SECRET-token'];
      const outputs: unknown[] = [];
      const errors: unknown[] = [];
      outputs.push(await exercise(backend(), dc));
      outputs.push(double.calls);
      const failing = [
        createMcpAtlassianBackend(
          { kind: 'datacenter_pat', baseUrl: dc.url, token: 'bad-SECRET-pat' },
          { url: double.url },
        ),
        // The double serves Data Center PATs only: a Cloud OAuth request is refused with 401.
        createMcpAtlassianBackend(
          {
            kind: 'cloud_oauth',
            baseUrl: 'https://api.atlassian.com/ex/jira/c-1',
            cloudId: 'c-1',
            accessToken: 'oauth-SECRET-token',
          },
          { url: double.url },
        ),
        createMcpAtlassianBackend(
          { kind: 'datacenter_pat', baseUrl: dc.url, token: 'bad-SECRET-pat' },
          { url: 'http://127.0.0.1:9/mcp', timeoutMs: 2_000 },
        ),
      ];
      for (const b of failing) {
        errors.push(
          await run(b, 'jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'Alex Martin' }).catch(
            (e: unknown) => e,
          ),
        );
      }
      expect(errors.map((e) => (e as JiraToolError).code)).toEqual([
        'unauthorized',
        'unauthorized',
        'unavailable',
      ]);
      const seen = [
        JSON.stringify(outputs),
        ...errors.flatMap((e) => {
          const err = e as JiraToolError;
          return [
            err.message,
            String(err.stack),
            JSON.stringify(err),
            JSON.stringify(err.toData()),
          ];
        }),
        JSON.stringify(spies.flatMap((s) => s.mock.calls)),
      ].join('\n');
      for (const secret of secrets) expect(seen).not.toContain(secret);
      for (const e of errors) expect((e as Error).cause).toBeUndefined();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('mcp-atlassian backend: pure parts', () => {
  it('sends credentials as per-request headers only', () => {
    expect(
      mcpAtlassianHeaders({ kind: 'datacenter_pat', baseUrl: 'https://jira.acme.io', token: 'p' }),
    ).toEqual({
      'X-Atlassian-Jira-Url': 'https://jira.acme.io',
      'X-Atlassian-Jira-Personal-Token': 'p',
    });
    expect(
      mcpAtlassianHeaders({
        kind: 'cloud_oauth',
        baseUrl: 'https://api.atlassian.com/ex/jira/c-1',
        cloudId: 'c-1',
        accessToken: 't',
      }),
    ).toEqual({ Authorization: 'Bearer t', 'X-Atlassian-Cloud-Id': 'c-1' });
  });

  it('enables the catalog plus one lookup the model never sees', () => {
    expect(MCP_ATLASSIAN_BACKEND_ONLY_TOOLS).toEqual(['jira_search_assignable_users']);
    expect([...MCP_ATLASSIAN_ENABLED_TOOLS].sort()).toEqual(
      [...JIRA_TOOL_NAMES, 'jira_search_assignable_users'].sort(),
    );
    for (const name of MCP_ATLASSIAN_BACKEND_ONLY_TOOLS) expect(isJiraToolName(name)).toBe(false);
    expect(Object.isFrozen(MCP_ATLASSIAN_ENABLED_TOOLS)).toBe(true);
  });

  it('reads mcp-atlassian search results like the REST backend (Cloud has no total)', () => {
    const issue = {
      id: '10001',
      key: 'DEMO-1',
      summary: 'Set up',
      status: { name: 'Done', category: 'Done' },
      assignee: { display_name: 'Unassigned' },
      issue_type: { name: 'Bug' },
      // mcp-atlassian 0.23.1 formats times in the container's zone (UTC in our deployments).
      updated: '2026-10-03 10:00:00 UTC',
    };
    const brief = {
      key: 'DEMO-1',
      summary: 'Set up',
      status: 'Done',
      assignee: null,
      type: 'Bug',
      updated: '2026-10-03T10:00:00Z',
    };
    // Times are ISO 8601 UTC on both backends; a zone we cannot read is passed on as is.
    for (const [raw, iso] of [
      ['2026-10-03T12:00:00.000+0200', '2026-10-03T10:00:00Z'],
      ['2026-10-03 12:00:00 CEST', '2026-10-03 12:00:00 CEST'],
    ]) {
      expect(searchFromMcp({ total: 1, issues: [{ ...issue, updated: raw }] }, 5)).toMatchObject({
        issues: [{ updated: iso }],
      });
    }
    expect(
      searchFromMcp(
        { total: -1, start_at: -1, max_results: -1, issues: [issue], next_page_token: 'n' },
        5,
      ),
    ).toEqual({ total: null, hasMore: true, issues: [brief] });
    expect(searchFromMcp({ total: -1, issues: [issue] }, 5)).toEqual({
      total: null,
      hasMore: false,
      issues: [brief],
    });
    expect(
      searchFromMcp(
        {
          total: 7,
          start_at: 0,
          issues: [{ ...issue, assignee: { display_name: 'Kim', name: 'kim', account_id: null } }],
        },
        5,
      ),
    ).toEqual({ total: 7, hasMore: true, issues: [{ ...brief, assignee: 'Kim' }] });
    expect(searchFromMcp('not json', 5)).toEqual({ total: null, hasMore: false, issues: [] });
  });

  it('maps mcp-atlassian error texts, including its user errors, to stable codes', () => {
    expect(
      codeFromToolText('Failed to assign issue DEMO-2: Could not find account ID for user: x'),
    ).toBe('not_found');
    expect(codeFromToolText("User 'x' not found.")).toBe('not_found');
    expect(codeFromToolText("Could not resolve email 'a@b.c' to a valid account ID")).toBe(
      'not_found',
    );
    expect(codeFromToolText("Could not determine how to look up user 'x'.")).toBe('not_found');
    expect(codeFromToolText('Authentication/Permission Error: 401 Unauthorized')).toBe(
      'unauthorized',
    );
    expect(codeFromToolText('403 Forbidden')).toBe('forbidden');
    expect(codeFromToolText('429 Too Many Requests')).toBe('rate_limited');
    expect(codeFromToolText('400 Bad Request')).toBe('invalid_request');
    expect(codeFromToolText('something else')).toBe('jira_error');
  });
});

describe('createJiraToolBackend', () => {
  it('uses REST for Cloud API tokens and mcp-atlassian for PATs and OAuth', () => {
    const dcCreds = {
      kind: 'datacenter_pat',
      baseUrl: 'https://jira.acme.io',
      token: 'p',
    } as const;
    expect(
      createJiraToolBackend(
        {
          kind: 'cloud_basic',
          baseUrl: 'https://acme.atlassian.net',
          email: 'a@b.c',
          apiToken: 't',
        },
        { outbound },
      )?.kind,
    ).toBe('rest');
    expect(createJiraToolBackend(dcCreds, { outbound })).toBeNull();
    expect(
      createJiraToolBackend(dcCreds, { outbound, mcpAtlassianUrl: 'http://mcp:8000/mcp' })?.kind,
    ).toBe('mcp-atlassian');
    expect(
      createJiraToolBackend(
        { kind: 'cloud_oauth', baseUrl: 'https://x', cloudId: 'c', accessToken: 't' },
        { outbound, mcpAtlassianUrl: 'http://mcp:8000/mcp' },
      )?.kind,
    ).toBe('mcp-atlassian');
  });
});

/** An HTTP server that accepts requests and never answers (or answers through `handler`). */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const open = new Set<ServerResponse>();
  let received = 0;
  const server: Server = createServer((req, res) => {
    received++;
    open.add(res);
    res.on('close', () => open.delete(res));
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    open,
    received: () => received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const callWith = <N extends JiraToolName>(
  b: JiraToolBackend,
  name: N,
  input: unknown,
  signal?: AbortSignal,
) => {
  const parsed = parseJiraToolInput(name, input);
  if (!parsed.success) throw new Error(`bad input for ${name}`);
  return b.call(name, parsed.data, { signal });
};

describe('cancellation, deadlines and refusals', () => {
  let dc: MockJira;
  let double: MockMcpAtlassian;
  let hang: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => {
    dc = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer good-pat',
      dataset: demoDataset(ANCHOR),
    });
    double = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'] });
    hang = await listen((req) => req.resume());
  });
  afterAll(async () => {
    await Promise.all([dc?.close(), double?.close(), hang?.close()]);
  });
  const pat = (baseUrl: string) => ({
    kind: 'datacenter_pat' as const,
    baseUrl,
    token: 'good-pat',
  });

  it('rejects an aborted MCP call promptly and still closes the client', async () => {
    const backend = createMcpAtlassianBackend(pat(dc.url), { url: `${hang.url}/mcp` });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    await expect(
      callWith(backend, 'jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'alex' }, ac.signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hang.received()).toBeGreaterThan(0);
    await vi.waitFor(() => expect(hang.open.size).toBe(0));

    const before = hang.received();
    await expect(
      callWith(backend, 'jira_get_issue', { issueKey: 'DEMO-1' }, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(hang.received()).toBe(before);
  });

  it('rejects an aborted REST call promptly', async () => {
    const backend = createRestJiraBackend(pat(hang.url), { outbound });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    await expect(
      callWith(backend, 'jira_get_issue', { issueKey: 'DEMO-1' }, ac.signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(hang.open.size).toBe(0));
  });

  it('gives an MCP assignment (connect + lookup + assign) one overall deadline', async () => {
    // Every request to the double is delayed by 150 ms: each one fits a 400 ms deadline on its
    // own, but the four of an assignment do not.
    const slow = await listen((req, res) => {
      setTimeout(() => {
        const target = new URL(double.url);
        const upstream = httpRequest(
          {
            host: target.hostname,
            port: target.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
          },
        );
        upstream.on('error', () => res.destroy());
        req.pipe(upstream);
      }, 150);
    });
    try {
      dc.writes.length = 0;
      const tight = createMcpAtlassianBackend(pat(dc.url), {
        url: `${slow.url}/mcp`,
        timeoutMs: 400,
      });
      await expect(
        callWith(tight, 'jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'alex' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(dc.writes).toEqual([]);
      const roomy = createMcpAtlassianBackend(pat(dc.url), {
        url: `${slow.url}/mcp`,
        timeoutMs: 5_000,
      });
      await expect(
        callWith(roomy, 'jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'alex' }),
      ).resolves.toMatchObject({ assignee: { id: 'alex' } });
    } finally {
      await slow.close();
    }
  });

  it('refuses names outside the catalog without calling anything', async () => {
    const before = double.calls.length;
    for (const backend of [
      createMcpAtlassianBackend(pat(dc.url), { url: double.url }),
      createRestJiraBackend(pat(dc.url), { outbound }),
    ]) {
      await expect(
        backend.call('jira_search_assignable_users' as JiraToolName, { query: 'alex' } as never),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(double.calls.length).toBe(before);
  });

  it('reads the double’s lookup failures as the codes they name', async () => {
    const backend = createMcpAtlassianBackend(pat(dc.url), { url: double.url });
    await expect(
      callWith(backend, 'jira_assign_issue', { issueKey: 'NOPE-1', assignee: 'alex' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const jiraDown = createMcpAtlassianBackend(pat('http://127.0.0.1:9'), { url: double.url });
    await expect(
      callWith(jiraDown, 'jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'alex' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    // The double (like mcp-atlassian) reports HTTP failures as requests' "<status> … Error".
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const kind = status < 500 ? 'Client' : 'Server';
      expect(codeFromToolText(`${status} ${kind} Error`)).toBe(codeForStatus(status));
    }
  });
});
