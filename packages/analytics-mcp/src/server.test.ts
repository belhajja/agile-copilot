import { METRIC_KEYS } from '@agile/dashboards';
import type { Db } from '@agile/db';
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { NOW, owner, startSyncHarness } from '@agile/sync/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AnalyticsServerOptions, createAnalyticsMcpServer } from './server';

describe('analytics MCP server (tenant-scoped, demo data)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let scrumId = '';
  let kanbanId = '';
  let connectionId = '';

  /** An MCP client talking to a server bound to `orgId` (what the agent does in-process). */
  async function connect(orgId: string, db?: Db, options?: AnalyticsServerOptions) {
    const server = createAnalyticsMcpServer({ db: db ?? h.db, orgId, now: () => NOW }, options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientTransport);
    return {
      client,
      call: async (name: string, args: Record<string, unknown> = {}) => {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
        return { isError: r.isError === true, text, body: JSON.parse(text) };
      },
      close: () => client.close(),
    };
  }

  beforeAll(async () => {
    h = await startSyncHarness();
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    await runSync(h.deps, { orgId: 'org_a', connectionId, trigger: 'manual' });
    scrumId = boards.find((b) => b.type === 'scrum')?.id ?? '';
    kanbanId = boards.find((b) => b.type === 'kanban')?.id ?? '';
  });
  afterAll(async () => h?.stop());

  it('lists the tools as read-only', async () => {
    const mcp = await connect('org_a');
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'explain_metric',
      'find_issues',
      'forecast',
      'get_metric',
      'list_boards',
      'list_metrics',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    // No tool lets the model pick a workspace, a connection, a user or a tenant.
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props.filter((p) => /org|connection|user|tenant/i.test(p))).toEqual([]);
    }
    await mcp.close();
  });

  it('answers with the demo numbers', async () => {
    const mcp = await connect('org_a');
    expect(
      (await mcp.call('list_boards')).body.boards.map((b: { name: string }) => b.name),
    ).toEqual(['DEMO Scrum', 'OPS Kanban']);
    const velocity = await mcp.call('get_metric', { boardId: scrumId, metric: 'average_velocity' });
    expect(velocity.body).toMatchObject({
      board: { name: 'DEMO Scrum' },
      params: { sprints: 6, unit: 'points' },
      data: { kind: 'kpi', value: 19, format: 'points' },
    });
    const cycle = await mcp.call('get_metric', { boardId: kanbanId, metric: 'cycle_time' });
    expect(cycle.body.data).toMatchObject({
      kind: 'table',
      rows: [
        ['50%', 3],
        ['85%', 8],
        ['95%', 8],
      ],
    });
    const forecast = await mcp.call('forecast', {
      boardId: kanbanId,
      question: 'how_many',
      days: 14,
    });
    expect(forecast.body.data.kind).toBe('table');
    const wip = await mcp.call('find_issues', { boardId: kanbanId, status: ['in_progress'] });
    expect(wip.body.total).toBe(4);
    const sprint = await mcp.call('find_issues', {
      boardId: scrumId,
      sprint: 'current',
      sort: 'key',
    });
    expect(sprint.body.total).toBeGreaterThan(0);
    const text = await mcp.call('find_issues', { boardId: scrumId, text: 'release pipeline' });
    expect(text.body.issues.map((i: { key: string }) => i.key)).toEqual(['DEMO-1']);
    expect((await mcp.call('list_metrics')).body.metrics).toHaveLength(METRIC_KEYS.length);
    expect((await mcp.call('explain_metric', { metric: 'say_do_ratio' })).body.how).toMatch(
      /committed/,
    );
    await mcp.close();
  });

  it('validates parameters through the widget catalog', async () => {
    const mcp = await connect('org_a');
    const bad = await mcp.call('get_metric', {
      boardId: scrumId,
      metric: 'velocity',
      params: { sprints: 500 },
    });
    expect(bad).toMatchObject({ isError: true, body: { error: expect.stringMatching(/sprints/) } });
    // At most 10 params keys: refused by the input schema before any work.
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    const tooMany = await mcp.client.callTool({
      name: 'get_metric',
      arguments: { boardId: scrumId, metric: 'velocity', params: many },
    });
    expect(tooMany.isError).toBe(true);
    expect((tooMany.content as { text: string }[])[0]?.text).toMatch(/at most 10 params/);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const ok = await mcp.call('get_metric', { boardId: scrumId, metric: 'velocity', params: ten });
    expect(ok.isError).toBe(false);
    await mcp.close();
  });

  it("never reads another workspace's board", async () => {
    const other = await connect('org_b');
    expect((await other.call('list_boards')).body.boards).toEqual([]);
    for (const boardId of [scrumId, 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const r = await other.call('get_metric', { boardId, metric: 'wip' });
      expect(r).toMatchObject({
        isError: true,
        body: { error: expect.stringMatching(/Unknown board/) },
      });
    }
    const leak = await other.call('find_issues', { boardId: scrumId });
    expect(leak.isError).toBe(true);
    await other.close();
  });

  it('treats a board deselected after setup as unknown', async () => {
    const mcp = await connect('org_a');
    try {
      await setBoardSelection(h.deps, owner(), connectionId, [kanbanId]);
      for (const [name, args] of [
        ['get_metric', { boardId: scrumId, metric: 'wip' }],
        ['forecast', { boardId: scrumId, question: 'how_many' }],
        ['find_issues', { boardId: scrumId }],
      ] as const) {
        expect(await mcp.call(name, args)).toMatchObject({
          isError: true,
          body: { error: expect.stringMatching(/Unknown board/) },
        });
      }
      expect((await mcp.call('get_metric', { boardId: kanbanId, metric: 'wip' })).isError).toBe(
        false,
      );
    } finally {
      await setBoardSelection(h.deps, owner(), connectionId, [scrumId, kanbanId]);
      await mcp.close();
    }
  });

  it('turns any other failure into a fixed error without driver text', async () => {
    const secret = 'postgres://app_user:s3cr3t-pw@db.internal:5432/agile';
    const broken = {
      transaction: async () => {
        throw new Error(`connection to ${secret} failed`);
      },
    } as unknown as Db;
    const seen: { name: string; code: string }[] = [];
    const mcp = await connect('org_a', broken, {
      onError: (error, code) => seen.push({ name: (error as Error).name, code }),
    });
    const calls: [string, Record<string, unknown>][] = [
      ['list_boards', {}],
      ['get_metric', { boardId: scrumId, metric: 'wip' }],
      ['forecast', { boardId: scrumId, question: 'when', items: 5 }],
      ['find_issues', { boardId: scrumId }],
    ];
    for (const [name, args] of calls) {
      const r = await mcp.call(name, args);
      expect(r).toEqual({
        isError: true,
        text: JSON.stringify({ error: 'The analytics tool failed (internal_error).' }),
        body: { error: 'The analytics tool failed (internal_error).' },
      });
      expect(r.text).not.toContain('s3cr3t');
      expect(r.text).not.toContain('db.internal');
    }
    expect(seen).toEqual(calls.map(() => ({ name: 'Error', code: 'internal_error' })));
    await mcp.close();
  });
});
