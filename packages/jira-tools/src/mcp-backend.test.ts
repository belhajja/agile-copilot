import { demoDataset, type MockJira, startMockJira } from '@agile/jira/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JiraToolError } from './backend';
import { isJiraToolName, JIRA_TOOL_NAMES } from './catalog';
import { createJiraToolBackend } from './index';
import {
  codeFromToolText,
  createMcpAtlassianBackend,
  MCP_ATLASSIAN_BACKEND_ONLY_TOOLS,
  MCP_ATLASSIAN_ENABLED_TOOLS,
  mcpAtlassianHeaders,
  searchFromMcp,
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
      body: { body: 'Blocked by the API team' },
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
      updated: '2026-10-03T10:00:00.000+0000',
    };
    const brief = {
      key: 'DEMO-1',
      summary: 'Set up',
      status: 'Done',
      assignee: null,
      type: 'Bug',
      updated: '2026-10-03T10:00:00.000+0000',
    };
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
