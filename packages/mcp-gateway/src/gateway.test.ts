import { auditLog, mcpRateBuckets, mcpTokens, member, organization, user } from '@agile/db';
import { updateWorkspaceSettings } from '@agile/privacy';
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { owner, startSyncHarness } from '@agile/sync/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleMcpHttpRequest, type McpHttpDeps } from './handler';
import { takeRequest } from './rate-limit';
import {
  authenticateToken,
  createMcpToken,
  LAST_USED_THROTTLE_MS,
  listMcpTokens,
  MAX_ACTIVE_TOKENS,
  revokeMcpToken,
  TokenError,
} from './tokens';

const ENDPOINT = 'http://agile.test/api/mcp';
const viewer = { orgId: 'org_a', userId: 'u_viewer', roles: ['viewer'] };
const admin = { orgId: 'org_a', userId: 'user_org_a', roles: ['owner'] };
const manager = { orgId: 'org_a', userId: 'u_manager', roles: ['manager'] };
const ownerB = { orgId: 'org_b', userId: 'u_owner_b', roles: ['owner'] };

describe('external analytics MCP (personal tokens)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let deps: McpHttpDeps;
  let planAllows = true;
  let boardIdA = '';

  /** An MCP client (the official SDK) whose HTTP requests reach the handler in process. */
  async function connect(token: string, d: McpHttpDeps = deps) {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (url, init) => handleMcpHttpRequest(d, new Request(url, init)),
    });
    await client.connect(transport);
    return client;
  }
  const post = (token: string, body: unknown, d: McpHttpDeps = deps) =>
    handleMcpHttpRequest(
      d,
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      }),
    );
  const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  beforeAll(async () => {
    h = await startSyncHarness();
    const connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    await runSync(h.deps, { orgId: 'org_a', connectionId, trigger: 'manual' });
    boardIdA = boards[0]?.id ?? '';
    await h.rawDb.insert(user).values([
      { id: 'u_owner_b', name: 'Ob', email: 'ob@example.com' },
      { id: 'u_viewer', name: 'Vi', email: 'vi@example.com' },
      { id: 'user_org_a', name: 'Own', email: 'own@example.com' },
      { id: 'u_manager', name: 'Ma', email: 'ma@example.com' },
    ]);
    await h.rawDb.insert(organization).values([
      { id: 'org_a', name: 'A', slug: 'a', createdAt: new Date() },
      { id: 'org_b', name: 'B', slug: 'b', createdAt: new Date() },
    ]);
    await h.rawDb.insert(member).values([
      {
        id: 'mb',
        organizationId: 'org_b',
        userId: 'u_owner_b',
        role: 'owner',
        createdAt: new Date(),
      },
      {
        id: 'm1',
        organizationId: 'org_a',
        userId: 'u_viewer',
        role: 'viewer',
        createdAt: new Date(),
      },
      {
        id: 'm2',
        organizationId: 'org_a',
        userId: 'user_org_a',
        role: 'owner',
        createdAt: new Date(),
      },
      {
        id: 'm3',
        organizationId: 'org_a',
        userId: 'u_manager',
        role: 'manager',
        createdAt: new Date(),
      },
    ]);
    deps = { db: h.db, planAllowsMcp: async () => planAllows, rateLimitPerMinute: 1000 };
  });
  afterAll(async () => h?.stop());

  it('issues tokens only when an admin enabled external MCP and the plan includes it', async () => {
    await expect(createMcpToken(deps, viewer, { name: 'Claude' })).rejects.toMatchObject({
      code: 'mcp_disabled',
    });
    await updateWorkspaceSettings(h.db, admin, { externalMcpEnabled: true });
    planAllows = false;
    await expect(createMcpToken(deps, viewer, { name: 'Claude' })).rejects.toMatchObject({
      code: 'plan_limit',
    });
    planAllows = true;
    await expect(
      createMcpToken(deps, { ...viewer, roles: ['member'] }, { name: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden_role' });
    await expect(createMcpToken(deps, viewer, { name: '' })).rejects.toBeInstanceOf(TokenError);
    // A workspace id the token format cannot carry is refused (the token would never parse).
    for (const orgId of ['org a', 'org.a', 'x'.repeat(65)]) {
      await expect(createMcpToken(deps, { ...viewer, orgId }, { name: 'x' })).rejects.toMatchObject(
        { code: 'invalid_input' },
      );
    }
    // Lifetimes are 30 to 365 days.
    for (const expiresInDays of [1, 29, 366]) {
      await expect(
        createMcpToken(deps, viewer, { name: 'x', expiresInDays }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    const created = await createMcpToken(deps, viewer, { name: 'Claude Desktop' });
    expect(created.token).toMatch(/^acp_org_a\.[A-Za-z0-9_-]{43}$/);
    const [listed] = await listMcpTokens(h.db, viewer);
    // Only a hash is stored; the list shows the prefix (workspace part + 4 secret characters).
    expect(created.prefix).toBe(created.token.slice(0, 'acp_org_a.'.length + 4));
    expect(listed).toMatchObject({ name: 'Claude Desktop', prefix: created.prefix });
    const [stored] = await h.rawDb.select().from(mcpTokens).where(eq(mcpTokens.id, created.id));
    expect(JSON.stringify(stored)).not.toContain(created.token.split('.')[1]);
    expect(JSON.stringify(await h.rawDb.select().from(auditLog))).not.toContain(created.token);
    const [audit] = await h.rawDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'mcp.token_created'), eq(auditLog.targetId, created.id)));
    expect(audit).toMatchObject({ actorUserId: 'u_viewer', targetType: 'mcp_token' });
  });

  it('serves the read-only analytics tools of the token’s workspace, audited per call', async () => {
    const { token } = await createMcpToken(deps, viewer, { name: 'Client' });
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'explain_metric',
        'find_issues',
        'forecast',
        'get_metric',
        'list_boards',
        'list_metrics',
      ]);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
      const result = await client.callTool({ name: 'list_boards', arguments: {} });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(
        JSON.parse(text)
          .boards.map((b: { name: string }) => b.name)
          .sort(),
      ).toEqual(['DEMO Scrum', 'OPS Kanban']);
    } finally {
      await client.close();
    }
    const calls = await h.rawDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'mcp.tool_called'), eq(auditLog.actorUserId, 'u_viewer')));
    expect(calls.map((c) => c.metadata)).toEqual([{ tool: 'list_boards' }]);
  });

  it('never writes a client-chosen string into the audit log as a tool name', async () => {
    const { token } = await createMcpToken(deps, manager, { name: 'Odd' });
    const res = await post(token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'jira_create_issue <script>', arguments: { secret: 'p@ss' } },
    });
    expect(res.status).toBe(200);
    const calls = await h.rawDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'mcp.tool_called'), eq(auditLog.actorUserId, 'u_manager')));
    expect(calls.map((c) => c.metadata)).toEqual([{ tool: 'unknown' }]);
  });

  it('answers 401 for missing, malformed, forged, revoked or no-longer-allowed tokens', async () => {
    const { id, token } = await createMcpToken(deps, viewer, { name: 'Soon revoked' });
    expect((await post(token, listTools)).status).toBe(200);
    const secret = token.split('.')[1];
    for (const bad of [
      '',
      'acp_org_a',
      `acp_org_b.${secret}`,
      `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    ]) {
      const res = await post(bad, listTools);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
    // The session cookie is never accepted.
    const cookieOnly = await handleMcpHttpRequest(
      deps,
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { cookie: 'better-auth.session_token=x', 'content-type': 'application/json' },
        body: JSON.stringify(listTools),
      }),
    );
    expect(cookieOnly.status).toBe(401);
    // Admin turns external MCP off: every token stops at once.
    await updateWorkspaceSettings(h.db, admin, { externalMcpEnabled: false });
    expect((await post(token, listTools)).status).toBe(401);
    await updateWorkspaceSettings(h.db, admin, { externalMcpEnabled: true });
    // The plan no longer includes it: same.
    planAllows = false;
    expect((await post(token, listTools)).status).toBe(401);
    planAllows = true;
    // Removed from the workspace: same, at once (every role holds `mcp.token`, and the schema
    // refuses any other role, so removal is the way to lose it).
    // Re-invited later (a new membership): tokens of the old membership stay dead, and creating a
    // token revokes them, so they no longer count against the cap.
    const { id: oldId, token: oldToken } = await createMcpToken(deps, viewer, { name: 'Old' });
    await h.rawDb.delete(member).where(eq(member.id, 'm1'));
    expect((await post(token, listTools)).status).toBe(401);
    await new Promise((r) => setTimeout(r, 5));
    await h.rawDb.insert(member).values({
      id: 'm1',
      organizationId: 'org_a',
      userId: 'u_viewer',
      role: 'viewer',
      createdAt: new Date(),
    });
    expect((await post(token, listTools)).status).toBe(401);
    expect((await post(oldToken, listTools)).status).toBe(401);
    const fresh = await createMcpToken(deps, viewer, { name: 'After rejoining' });
    expect((await post(fresh.token, listTools)).status).toBe(200);
    const mine = await listMcpTokens(h.db, viewer);
    expect(mine.filter((t) => t.revokedAt === null).map((t) => t.id)).toEqual([fresh.id]);
    expect(mine.find((t) => t.id === oldId)?.revokedAt).not.toBeNull();
    // An admin revokes a token.
    await revokeMcpToken(h.db, admin, fresh.id);
    expect((await post(fresh.token, listTools)).status).toBe(401);
    expect((await post(token, listTools)).status).toBe(401);
    await expect(revokeMcpToken(h.db, admin, fresh.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(revokeMcpToken(h.db, admin, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(revokeMcpToken(h.db, admin, 'not-a-uuid')).rejects.toMatchObject({
      code: 'not_found',
    });
    // Expired.
    const later = { ...deps, now: () => new Date(Date.now() + 400 * 86_400_000) };
    const { token: other } = await createMcpToken(deps, viewer, { name: 'Expires' });
    expect((await post(other, listTools, later)).status).toBe(401);
  });

  it('lets people revoke only their own tokens; owners and admins see and revoke everyone’s', async () => {
    const { id } = await createMcpToken(deps, admin, { name: 'Admin token' });
    await expect(revokeMcpToken(h.db, viewer, id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listMcpTokens(h.db, viewer)).every((t) => t.userId === 'u_viewer')).toBe(true);
    const all = await listMcpTokens(h.db, admin);
    expect(new Set(all.map((t) => t.userId))).toEqual(
      new Set(['u_viewer', 'user_org_a', 'u_manager']),
    );
    await revokeMcpToken(h.db, admin, id);
  });

  it('caps active tokens per person, even when they are created at the same time', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_ACTIVE_TOKENS + 5 }, (_, i) =>
        createMcpToken(deps, admin, { name: `t${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_ACTIVE_TOKENS);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'too_many_tokens' });
    }
    // Revoking one frees a place.
    const [first] = await listMcpTokens(h.db, { ...admin, roles: ['viewer'] });
    await revokeMcpToken(h.db, admin, first?.id ?? '');
    await expect(createMcpToken(deps, admin, { name: 'again' })).resolves.toBeDefined();
  });

  it('records the last use at most once per throttle window', async () => {
    const { id, token } = await createMcpToken(deps, viewer, { name: 'Used' });
    const at = (ms: number) => ({ ...deps, now: () => new Date(ms) });
    const lastUsed = async () =>
      (await h.rawDb.select().from(mcpTokens).where(eq(mcpTokens.id, id)))[0]?.lastUsedAt;
    const t0 = Date.now();
    expect(await authenticateToken(at(t0), token)).not.toBeNull();
    expect((await lastUsed())?.getTime()).toBe(t0);
    expect(await authenticateToken(at(t0 + LAST_USED_THROTTLE_MS - 1000), token)).not.toBeNull();
    expect((await lastUsed())?.getTime()).toBe(t0);
    expect(await authenticateToken(at(t0 + LAST_USED_THROTTLE_MS + 1000), token)).not.toBeNull();
    expect((await lastUsed())?.getTime()).toBe(t0 + LAST_USED_THROTTLE_MS + 1000);
  });

  it('limits requests per person per minute, refuses big bodies and non-POST methods', async () => {
    const { token } = await createMcpToken(deps, viewer, { name: 'Busy' });
    const { token: second } = await createMcpToken(deps, viewer, { name: 'Busy too' });
    // A fixed minute of its own (earlier tests spent this person's budget for the current one).
    const at = Date.now() + 86_400_000;
    const limited = { ...deps, rateLimitPerMinute: 3, now: () => new Date(at) };
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) statuses.push((await post(token, listTools, limited)).status);
    // A second token of the same person shares the budget (more tokens give no more requests).
    statuses.push((await post(second, listTools, limited)).status);
    statuses.push((await post(second, listTools, limited)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Someone else's budget is their own.
    const { token: other } = await createMcpToken(deps, manager, { name: 'Other' });
    expect((await post(other, listTools, limited)).status).toBe(200);
    const res = await post(token, listTools, limited);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: 'rate_limited' });

    const big = await post(token, { ...listTools, params: { pad: 'x'.repeat(70_000) } });
    expect(big.status).toBe(413);
    // No Content-Length (a streamed body): the cap still holds while reading.
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let sent = 0;
    const streamed = await handleMcpHttpRequest(
      deps,
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: new ReadableStream({
          pull(controller) {
            if (sent++ < 100) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThan(10); // stopped reading early

    const get = await handleMcpHttpRequest(
      deps,
      new Request(ENDPOINT, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(get.status).toBe(405);
    const del = await handleMcpHttpRequest(
      deps,
      new Request(ENDPOINT, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(del.status).toBe(405);
  });

  it('counts concurrent requests exactly (no lost updates across replicas)', async () => {
    const key = { orgId: 'org_a', userId: 'u_race' };
    const now = new Date('2026-10-04T10:00:30Z');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => takeRequest(h.db, key, 5, now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.find((r) => !r.allowed)).toEqual({ allowed: false, retryAfterSeconds: 30 });
    const [bucket] = await h.rawDb
      .select()
      .from(mcpRateBuckets)
      .where(eq(mcpRateBuckets.userId, 'u_race'));
    expect(bucket?.count).toBe(20);
    // The next window starts afresh.
    const next = await takeRequest(h.db, key, 5, new Date('2026-10-04T10:01:00Z'));
    expect(next).toEqual({ allowed: true });
  });

  /** How many tool calls the audit log holds (all actors). */
  const toolCalls = async () =>
    (await h.rawDb.select().from(auditLog).where(eq(auditLog.action, 'mcp.tool_called'))).length;
  const call = (id: number | undefined, name = 'list_boards') => ({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method: 'tools/call',
    params: { name, arguments: {} },
  });

  it('refuses JSON-RPC batches and malformed messages before any audit or tool call', async () => {
    const { token } = await createMcpToken(deps, viewer, { name: 'Shapes' });
    const before = await toolCalls();
    const batch = await post(
      token,
      Array.from({ length: 50 }, (_, i) => call(i + 1)),
    );
    expect(batch.status).toBe(400);
    expect(await batch.json()).toEqual({ error: 'invalid_request' });
    for (const bad of [
      [call(1)],
      [],
      { method: 'tools/call', params: { name: 'list_boards' } }, // no jsonrpc
      { ...call(1), jsonrpc: '1.0' },
      'tools/call',
      null,
      42,
    ]) {
      const res = await post(token, bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
    // A notification-shaped call (no id) is never executed, so never audited.
    expect((await post(token, call(undefined))).status).toBe(202);
    // Oversized or unparsable bodies: nothing audited either.
    const big = await post(token, {
      ...call(1),
      params: { name: 'list_boards', pad: 'x'.repeat(70_000) },
    });
    expect(big.status).toBe(413);
    const notJson = await handleMcpHttpRequest(
      deps,
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"',
      }),
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'invalid_json' });
    expect(await toolCalls()).toBe(before);
    // A single well-formed call still works, audited once.
    const ok = await post(token, call(7));
    expect(ok.status).toBe(200);
    const answer = (await ok.json()) as { id: number; result: { content: { text: string }[] } };
    expect(answer.id).toBe(7);
    expect(JSON.parse(answer.result.content[0]?.text ?? '{}').boards).toHaveLength(2);
    expect(await toolCalls()).toBe(before + 1);
  });

  it('serves each token only its own workspace', async () => {
    await updateWorkspaceSettings(h.db, ownerB, { externalMcpEnabled: true });
    const { token } = await createMcpToken(deps, ownerB, { name: 'B' });
    const client = await connect(token);
    try {
      const boards = await client.callTool({ name: 'list_boards', arguments: {} });
      const text = (boards.content as { text: string }[])[0]?.text ?? '';
      expect(JSON.parse(text)).toEqual({ boards: [] });
      // org_a's board id, asked from org_b: unknown there.
      const metric = await client.callTool({
        name: 'get_metric',
        arguments: { metric: 'throughput', boardId: boardIdA },
      });
      expect(metric.isError).toBe(true);
      expect((metric.content as { text: string }[])[0]?.text).toContain('unknown_board');
      expect((metric.content as { text: string }[])[0]?.text).not.toContain('DEMO');
    } finally {
      await client.close();
    }
    // org_a's token still names org_a only; swapping the workspace part never authenticates.
    const { token: tokenA } = await createMcpToken(deps, viewer, { name: 'A' });
    const swapped = `acp_org_b.${tokenA.split('.')[1]}`;
    expect((await post(swapped, listTools)).status).toBe(401);
  });
});
