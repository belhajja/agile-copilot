import type { Db } from '@agile/db';
import { demoDataset, type MockJiraDataset } from '@agile/jira/testing';
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { ANCHOR, NOW, owner, startSyncHarness } from '@agile/sync/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsMcpServer } from './server';

/** The demo Scrum board's sprints 1-3 closed, 4 active, plus a future sprint 5 (not in the stock demo data). */
function datasetWithFutureSprint(): MockJiraDataset {
  const dataset = demoDataset(ANCHOR);
  dataset.sprints.push({
    id: 5,
    boardId: 1,
    name: 'DEMO Sprint 5',
    state: 'future',
    goal: 'Sprint 5 goal',
  });
  return dataset;
}

describe('list_sprints (tenant-scoped, demo data + a future sprint)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let scrumId = '';
  let connectionId = '';

  async function connect(orgId: string, db?: Db) {
    const server = createAnalyticsMcpServer({ db: db ?? h.db, orgId, now: () => NOW });
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
    h = await startSyncHarness({ dataset: datasetWithFutureSprint() });
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
  });
  afterAll(async () => h?.stop());

  it('lists the sprints with their official dates and issue counts, future first then newest-start first', async () => {
    const mcp = await connect('org_a');
    const r = await mcp.call('list_sprints', { boardId: scrumId });
    expect(r.isError).toBe(false);
    expect(r.body.board).toMatchObject({ name: 'DEMO Scrum' });
    expect(r.body.sprints.map((s: { name: string }) => s.name)).toEqual([
      'DEMO Sprint 5',
      'DEMO Sprint 4',
      'DEMO Sprint 3',
      'DEMO Sprint 2',
      'DEMO Sprint 1',
    ]);
    expect(r.body.hasMore).toBe(false);

    const future = r.body.sprints[0];
    expect(future).toMatchObject({
      jiraSprintId: 5,
      state: 'future',
      startAt: null,
      endAt: null,
      completeAt: null,
      goal: 'Sprint 5 goal',
      issueCount: 0,
    });

    const closed3 = r.body.sprints.find((s: { name: string }) => s.name === 'DEMO Sprint 3');
    expect(closed3).toMatchObject({
      jiraSprintId: 3,
      state: 'closed',
      goal: 'Sprint 3 goal',
      startAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      endAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      completeAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
    });
    expect(closed3.issueCount).toBeGreaterThan(0);

    const active4 = r.body.sprints.find((s: { name: string }) => s.name === 'DEMO Sprint 4');
    expect(active4).toMatchObject({ state: 'active', completeAt: null });
    expect(active4.issueCount).toBeGreaterThan(0);
    await mcp.close();
  });

  it('filters by state', async () => {
    const mcp = await connect('org_a');
    const r = await mcp.call('list_sprints', { boardId: scrumId, state: 'closed' });
    expect(r.body.sprints.map((s: { name: string }) => s.name).sort()).toEqual([
      'DEMO Sprint 1',
      'DEMO Sprint 2',
      'DEMO Sprint 3',
    ]);
    expect(r.body.sprints.every((s: { state: string }) => s.state === 'closed')).toBe(true);
    await mcp.close();
  });

  it('filters by nameContains, case-insensitive', async () => {
    const mcp = await connect('org_a');
    const r = await mcp.call('list_sprints', { boardId: scrumId, nameContains: 'sprint 2' });
    expect(r.body.sprints.map((s: { name: string }) => s.name)).toEqual(['DEMO Sprint 2']);
    await mcp.close();
  });

  it('limits results and reports hasMore', async () => {
    const mcp = await connect('org_a');
    const r = await mcp.call('list_sprints', { boardId: scrumId, limit: 3 });
    expect(r.body.sprints.map((s: { name: string }) => s.name)).toEqual([
      'DEMO Sprint 5',
      'DEMO Sprint 4',
      'DEMO Sprint 3',
    ]);
    expect(r.body.hasMore).toBe(true);
    await mcp.close();
  });

  it('rejects an unknown board', async () => {
    const mcp = await connect('org_a');
    const r = await mcp.call('list_sprints', { boardId: 'not-a-uuid' });
    expect(r).toMatchObject({
      isError: true,
      body: { error: expect.stringMatching(/Unknown board/), code: 'unknown_board' },
    });
    await mcp.close();
  });

  it("never reveals another workspace's board", async () => {
    const other = await connect('org_b');
    const r = await other.call('list_sprints', { boardId: scrumId });
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('unknown_board');
    await other.close();
  });
});
