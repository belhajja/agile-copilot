import { randomUUID } from 'node:crypto';
import { agentApprovals } from '@agile/db';
import type { MockChatMessage } from '@agile/llm/testing';
import { manager, owner, viewer } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConversation } from './conversations';
import type { AgentActor } from './deps';
import { systemPrompt } from './prompt';
import { startAgentHarness, textOf } from './test-harness';
import { AgentToolError } from './tool-errors';
import { jiraAccessOf, jiraSites, jiraTools } from './tools';

const contentOf = (m: MockChatMessage | undefined) =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');

describe('live Jira by role (Phase 5)', () => {
  let h: Awaited<ReturnType<typeof startAgentHarness>>;

  beforeAll(async () => {
    h = await startAgentHarness();
  });
  afterAll(async () => {
    await h?.stop();
  });

  const jiraToolsSent = () =>
    (h.llm.requests.at(-1)?.tools ?? []).filter((t) => t.startsWith('jira_')).sort();

  it('a manager reads Jira and proposes changes that run once approved', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    const r = await h.ask(manager(), id, 'Please comment on DEMO-2: Managed by a manager');
    expect(r.status).toBe(200);
    expect(jiraToolsSent()).toEqual(
      expect.arrayContaining(['jira_add_comment', 'jira_get_issue', 'jira_search']),
    );
    const convo = await loadConversation(h.db, manager(), id);
    const part = convo?.messages.at(-1)?.parts.find((p) => p.type === 'tool-jira_add_comment') as
      | { approval?: { id: string } }
      | undefined;
    const approvalId = part?.approval?.id ?? '';
    expect(approvalId).not.toBe('');
    // Nothing reaches Jira before the approval.
    expect(h.mock.writes).toEqual([]);

    const decided = await h.send(manager(), {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(textOf(decided.chunks)).toBe('Done: the comment is posted.');
    expect(h.mock.writes).toHaveLength(1);
    const [row] = await h.rawDb
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.conversationId, id));
    expect(row).toMatchObject({ userId: manager().userId, status: 'executed', resultCode: 'ok' });
  });

  it('a viewer, and a legacy `member` role, get the analytics tools only', async () => {
    for (const actor of [viewer(), { ...viewer(), roles: ['member'] }] as AgentActor[]) {
      h.mock.writes.length = 0;
      const r = await h.ask(actor, randomUUID(), 'Please comment on DEMO-1: Viewers cannot write');
      expect(r.status).toBe(200);
      expect(r.chunks.some((c) => c.type === 'tool-approval-request')).toBe(false);
      expect(jiraToolsSent()).toEqual([]);
      expect(contentOf(h.llm.requests.at(-1)?.messages[0])).toContain(
        'Live Jira queries are not available for your role.',
      );
      expect(h.mock.writes).toEqual([]);
    }
  });

  it('describes each level of access in the system prompt', () => {
    expect(jiraAccessOf(owner(), true)).toBe('full');
    expect(jiraAccessOf(manager(), true)).toBe('full');
    expect(jiraAccessOf(viewer(), true)).toBe('forbidden_role');
    expect(jiraAccessOf(owner(), false)).toBe('unavailable');
    const now = new Date('2026-10-04T00:00:00Z');
    expect(systemPrompt({ now, jiraSites: [], jira: 'forbidden_role' })).toContain(
      'for the Manager role',
    );
    expect(systemPrompt({ now, jiraSites: [], jira: 'read_only' })).toContain(
      'Changing Jira is not\navailable for your role',
    );
  });

  it('a manager demoted to viewer after a proposal can only deny it (decision time)', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    await h.ask(manager(), id, 'Please comment on DEMO-6: Before the demotion');
    const convo = await loadConversation(h.db, manager(), id);
    const part = convo?.messages.at(-1)?.parts.find((p) => p.type === 'tool-jira_add_comment') as
      | { approval?: { id: string } }
      | undefined;
    const approvalId = part?.approval?.id ?? '';
    expect(approvalId).not.toBe('');

    const demoted: AgentActor = { ...manager(), roles: ['viewer'] };
    const r = await h.send(demoted, {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(r.status).toBe(200);
    expect(h.mock.writes).toEqual([]);
    const [row] = await h.rawDb
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.conversationId, id));
    expect(row?.status).toBe('denied');
    const after = await loadConversation(h.db, demoted, id);
    const decided = after?.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-jira_add_comment') as {
      approval?: { approved?: boolean; reason?: string };
    };
    expect(decided?.approval).toMatchObject({ approved: false });
    expect(decided?.approval?.reason).toContain('forbidden_role');
  });

  it('re-checks the role when a Jira tool runs (execute time), before anything reaches Jira', async () => {
    const actor: AgentActor = { ...manager(), roles: ['manager'] };
    const sites = await jiraSites(h.deps, actor, h.deps.mcpAtlassianUrl);
    const site = sites.find((s) => s.usable)?.id;
    const tools = jiraTools(h.deps, actor, randomUUID(), sites);
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['jira_get_issue', 'jira_add_comment']),
    );
    // The role is lost after the tools were built (e.g. during a long reply).
    actor.roles = ['viewer'];
    h.mock.writes.length = 0;
    const callsBefore = h.mcp.calls.length;
    const run = (name: string, input: Record<string, unknown>) =>
      tools[name]?.execute?.({ ...input, site } as never, {
        toolCallId: randomUUID(),
        messages: [],
        context: {},
      });
    for (const [name, input] of [
      ['jira_get_issue', { issueKey: 'DEMO-1' }],
      ['jira_add_comment', { issueKey: 'DEMO-1', body: 'Never sent' }],
    ] as const) {
      const err = await Promise.resolve(run(name, input)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentToolError);
      expect((err as AgentToolError).code).toBe('forbidden_role');
    }
    expect(h.mcp.calls.length).toBe(callsBefore);
    expect(h.mock.writes).toEqual([]);
  });
});
