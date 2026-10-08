import { randomUUID } from 'node:crypto';
import { agentApprovals, agentConversations } from '@agile/db';
import { owner } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConversation } from './conversations';
import type { AgentDeps } from './deps';
import { startAgentHarness, textOf } from './test-harness';

/** Faults armed by a test; every wrapped function runs the real one otherwise. */
const faults = vi.hoisted(() => ({
  build: false,
  convert: false,
  holdsTurn: false,
  heldHistory: false,
  release: false,
  persist: false,
  mcpClose: false,
}));
type Fault = keyof typeof faults;
/** Calls of the turn's tools close function. */
const tools = vi.hoisted(() => ({ closes: 0 }));

vi.mock('./tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools')>();
  return {
    ...actual,
    buildAgentTools: async (...args: Parameters<typeof actual.buildAgentTools>) => {
      if (faults.build) throw new Error('tools down');
      const built = await actual.buildAgentTools(...args);
      return {
        ...built,
        close: async () => {
          tools.closes++;
          await built.close();
        },
      };
    },
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    convertToModelMessages: async (...args: Parameters<typeof actual.convertToModelMessages>) => {
      if (faults.convert) throw new Error('history unreadable');
      return actual.convertToModelMessages(...args);
    },
  };
});

vi.mock('./conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversations')>();
  const failing =
    <A extends unknown[], R>(fault: Fault, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (faults[fault]) throw new Error(`${fault} broken`);
      return fn(...args);
    };
  return {
    ...actual,
    holdsTurn: failing('holdsTurn', actual.holdsTurn),
    heldHistory: failing('heldHistory', actual.heldHistory),
    releaseTurn: failing('release', actual.releaseTurn),
    // The first write of the persist step.
    endTurn: failing('persist', actual.endTurn),
  };
});

vi.mock('@agile/analytics-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agile/analytics-mcp')>();
  return {
    ...actual,
    createAnalyticsMcpServer: (...args: Parameters<typeof actual.createAnalyticsMcpServer>) => {
      const server = actual.createAnalyticsMcpServer(...args);
      const close = server.close.bind(server);
      server.close = async () => {
        await close();
        if (faults.mcpClose) throw new Error('mcp close failed');
      };
      return server;
    },
  };
});

describe('a chat turn that fails ends cleanly', () => {
  let h: Awaited<ReturnType<typeof startAgentHarness>>;
  beforeAll(async () => {
    h = await startAgentHarness();
  });
  afterAll(async () => h?.stop());
  afterEach(() => {
    for (const key of Object.keys(faults) as Fault[]) faults[key] = false;
  });

  const lease = async (id: string) =>
    (
      await h.rawDb
        .select({ turnId: agentConversations.turnId })
        .from(agentConversations)
        .where(eq(agentConversations.id, id))
    )[0]?.turnId ?? null;

  const approvalRow = async (id: string) =>
    (await h.rawDb.select().from(agentApprovals).where(eq(agentApprovals.conversationId, id)))[0];

  /** Logs the codes `onError` receives. */
  const recording = () => {
    const codes: string[] = [];
    const deps: AgentDeps = { ...h.deps, onError: (_e, code) => codes.push(code) };
    return { codes, deps };
  };

  /** Proposes a Jira comment, arms `fault`, then approves it; the turn's outcome is returned. */
  async function approveWith(issue: string, fault: Fault) {
    const id = randomUUID();
    await h.ask(owner(), id, `Please comment on ${issue}`);
    const part = (await loadConversation(h.db, owner(), id))?.messages
      .at(-1)
      ?.parts.find((p) => p.type === 'tool-jira_add_comment') as { approval?: { id: string } };
    const approvalId = part?.approval?.id ?? '';
    h.mock.writes.length = 0;
    tools.closes = 0;
    const { codes, deps } = recording();
    faults[fault] = true;
    const result = await h
      .sendWith(deps, owner(), { conversationId: id, approvals: [{ approvalId, approved: true }] })
      .catch((e: unknown) => e);
    faults[fault] = false;
    return { id, codes, result };
  }

  it('when the tools cannot be built: the approved change is closed, the lease released', async () => {
    const run = await approveWith('DEMO-20: Build fails', 'build');
    expect(run.result).toBeInstanceOf(Error);
    expect(run.codes).toEqual(['turn_failed']);
    expect(h.mock.writes).toEqual([]);
    expect(await approvalRow(run.id)).toMatchObject({
      status: 'failed',
      resultCode: 'not_executed',
    });
    expect(await lease(run.id)).toBeNull();
  });

  it('when the history cannot be converted: the tools are closed too', async () => {
    const run = await approveWith('DEMO-21: Convert fails', 'convert');
    expect(run.result).toBeInstanceOf(Error);
    expect(run.codes).toEqual(['turn_failed']);
    expect(tools.closes).toBe(1);
    expect(h.mock.writes).toEqual([]);
    expect(await approvalRow(run.id)).toMatchObject({
      status: 'failed',
      resultCode: 'not_executed',
    });
    expect(await lease(run.id)).toBeNull();
  });

  it('when storing the reply fails: the change that ran is stored as done, the lease released', async () => {
    const run = await approveWith('DEMO-22: Persist fails', 'persist');
    expect(run.codes).toContain('persist_failed');
    expect(h.mock.writes).toHaveLength(1);
    expect(await approvalRow(run.id)).toMatchObject({ status: 'executed', resultCode: 'ok' });
    const part = (await loadConversation(h.db, owner(), run.id))?.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-jira_add_comment') as { state: string };
    expect(part.state).toBe('output-available');
    expect(tools.closes).toBe(1);
    expect(await lease(run.id)).toBeNull();
  });

  it('a failing lease check is logged and the turn goes on', async () => {
    const run = await approveWith('DEMO-23: Check fails', 'holdsTurn');
    expect(run.result).toMatchObject({ status: 200 });
    expect(run.codes).toContain('turn_check_failed');
    expect(run.codes).not.toContain('turn_failed');
    expect(h.mock.writes).toHaveLength(1);
    expect(await approvalRow(run.id)).toMatchObject({ status: 'executed', resultCode: 'ok' });
    expect(await lease(run.id)).toBeNull();
  });

  it('a failing repair is logged and the lease is still released', async () => {
    faults.heldHistory = true;
    const run = await approveWith('DEMO-24: Repair fails', 'build');
    expect(run.codes).toEqual(['turn_failed', 'settle_failed']);
    expect(await lease(run.id)).toBeNull();
  });

  it('a failing release is logged (the lease then expires on its own)', async () => {
    faults.release = true;
    const run = await approveWith('DEMO-25: Release fails', 'build');
    expect(run.codes).toEqual(['turn_failed', 'turn_release_failed']);
    expect(await approvalRow(run.id)).toMatchObject({ resultCode: 'not_executed' });
    expect(await lease(run.id)).not.toBeNull();
  });

  it('a failing MCP close is logged and never fails the reply', async () => {
    const id = randomUUID();
    const { codes, deps } = recording();
    faults.mcpClose = true;
    const r = await h.sendWith(deps, owner(), {
      conversationId: id,
      message: { id: randomUUID(), text: 'What is our velocity?' },
    });
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toMatch(/19 points/);
    expect(codes).toEqual(['mcp_close_failed']);
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(await lease(id)).toBeNull();
  });
});
