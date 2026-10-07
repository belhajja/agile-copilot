import { randomUUID } from 'node:crypto';
import { createLlmConnection, setLlmConnectionPrices } from '@agile/connections';
import {
  agentApprovals,
  agentConversations,
  agentMessages,
  agentUsage,
  auditLog,
  jiraBoards as jiraBoardsTable,
  jiraConnections,
  llmConnections,
} from '@agile/db';
import { createLanguageModel, type LlmConfig } from '@agile/llm';
import { agentDemoScript, type MockChatMessage, type MockScript } from '@agile/llm/testing';
import { createOutboundFetch } from '@agile/net';
import { member, owner } from '@agile/sync/testing';
import { asSchema, type LanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRequiredError, claimApprovedExecution, hashInput } from './approvals';
import { loadConversation, setConversationArchived, setConversationModel } from './conversations';
import type { AgentDeps } from './deps';
import { startAgentHarness, textOf } from './test-harness';
import { AgentToolError, toolErrorText } from './tool-errors';
import { analyticsTools, jiraTools } from './tools';
import { handleAgentRequest } from './turn';
import { recordUsage, usageSummary } from './usage';

/**
 * The demo script, plus "create a padded issue": a write whose input the tool schema rewrites
 * (trimmed summary, optional description left out, an unknown key stripped).
 */
const script: MockScript = (req) => {
  const last = req.messages.at(-1);
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  if (
    last?.role === 'user' &&
    /create a padded issue/i.test(String(lastUser?.content)) &&
    req.tools.includes('jira_create_issue')
  ) {
    return {
      toolCalls: [
        {
          name: 'jira_create_issue',
          args: { projectKey: 'DEMO', summary: '  Follow up  ', issueType: 'Task', extra: 'x' },
        },
      ],
    };
  }
  const ask = String(lastUser?.content);
  const assign = /assign ([A-Z][A-Z0-9]+-\d+) to (.+)$/i.exec(ask);
  if (last?.role === 'user' && assign && req.tools.includes('jira_assign_issue')) {
    return {
      toolCalls: [
        { name: 'jira_assign_issue', args: { issueKey: assign[1], assignee: assign[2] } },
      ],
    };
  }
  // "…then break": the model call after the first tool result fails (HTTP 500).
  if (last?.role === 'tool' && /then break/i.test(ask)) throw new Error('scripted failure');
  // "Keep searching": a model that never stops calling tools while it has any.
  if (/keep searching/i.test(ask)) {
    return req.tools.includes('list_boards')
      ? { toolCalls: [{ name: 'list_boards', args: {} }] }
      : { text: 'Here is what I found so far.' };
  }
  return agentDemoScript(req);
};

/** The real model (mock LLM over HTTP), its model calls from the `from`-th on held until `open()`. */
function gatedModel(from: number) {
  let open = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let reachedGate = () => {};
  const reached = new Promise<void>((r) => {
    reachedGate = r;
  });
  let calls = 0;
  const createModel = (config: LlmConfig) => {
    const model = createLanguageModel(config, {
      fetch: createOutboundFetch({ allowedPrivateHosts: ['127.0.0.1'] }),
    }) as unknown as { doStream: (o: unknown) => Promise<unknown> };
    return new Proxy(model, {
      get: (target, prop) =>
        prop === 'doStream'
          ? async (o: unknown) => {
              if (++calls >= from) {
                reachedGate();
                await gate;
              }
              return target.doStream(o);
            }
          : Reflect.get(target, prop),
    }) as unknown as LanguageModel;
  };
  return { createModel, open: () => open(), reached };
}

/** A scripted in-process model (AI SDK mock): one stream of parts per model call. */
function scriptedModel(steps: unknown[][]) {
  let n = 0;
  return () =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks: (steps[n++] ?? []) as never[] }),
      }),
    });
}

const usageOf = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

async function waitFor(check: () => Promise<boolean>, ms = 10_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const contentOf = (m: MockChatMessage | undefined) =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');

/** Tool calls the model is shown without a result: most providers reject such a request. */
const danglingToolCalls = (messages: MockChatMessage[] = []) => {
  const answered = new Set(messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : [])));
  return messages
    .flatMap((m) => m.tool_calls ?? [])
    .map((c) => c.id)
    .filter((id) => !answered.has(id));
};

const NOT_SENT = 'The change was approved but not sent. Ask again to retry.';

describe('agent turns (mock LLM over HTTP, mcp-atlassian double, mock Jira)', () => {
  let h: Awaited<ReturnType<typeof startAgentHarness>>;
  beforeAll(async () => {
    h = await startAgentHarness({ script });
  });
  afterAll(async () => h?.stop());

  const approvalPartOf = async (conversationId: string, tool = 'jira_add_comment') => {
    const convo = await loadConversation(h.db, owner(), conversationId);
    const part = convo?.messages.at(-1)?.parts.find((p) => p.type === `tool-${tool}`) as
      | { state: string; approval?: { id: string }; input: unknown }
      | undefined;
    if (!part?.approval) throw new Error('no approval request stored');
    return { state: part.state, approvalId: part.approval.id, input: part.input };
  };
  const auditActions = async () =>
    (await h.rawDb.select().from(auditLog).where(eq(auditLog.orgId, 'org_a')))
      .map((r) => r.action)
      .filter((a) => a.startsWith('agent_action.'));
  const approvalRows = (conversationId: string) =>
    h.rawDb.select().from(agentApprovals).where(eq(agentApprovals.conversationId, conversationId));
  const auditActionsOf = async (approvalId: string) =>
    (await h.rawDb.select().from(auditLog).where(eq(auditLog.orgId, 'org_a')))
      .filter((r) => (r.metadata as { approvalId?: string }).approvalId === approvalId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => r.action);

  /** Rewrites the stored Jira-comment part of a conversation (simulating an earlier state). */
  const rewritePart = async (
    conversationId: string,
    change: (part: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const rows = await h.rawDb
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId));
    for (const row of rows) {
      const parts = (row.parts as Record<string, unknown>[]).map((p) =>
        p.type === 'tool-jira_add_comment' ? change(p) : p,
      );
      await h.rawDb
        .update(agentMessages)
        .set({ parts })
        .where(and(eq(agentMessages.conversationId, conversationId), eq(agentMessages.id, row.id)));
    }
  };

  /** Changes a pending proposal's input everywhere it is stored (part, row, hash). */
  const rewriteProposal = async (conversationId: string, approvalId: string, input: unknown) => {
    await rewritePart(conversationId, (p) => ({ ...p, input }));
    await h.rawDb
      .update(agentApprovals)
      .set({ input: input as Record<string, unknown>, inputHash: hashInput(input) })
      .where(eq(agentApprovals.approvalId, approvalId));
  };

  /** A new message gets an answer, and the model is shown no tool call without its result. */
  const expectNextMessageWorks = async (conversationId: string) => {
    const r = await h.ask(owner(), conversationId, 'What is our velocity?');
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toMatch(/19 points/);
    // The first model call of that turn carries the whole history.
    const first = h.llm.requests.findLast(
      (q) =>
        q.messages.at(-1)?.role === 'user' &&
        contentOf(q.messages.at(-1)) === 'What is our velocity?',
    );
    expect(first).toBeDefined();
    expect(danglingToolCalls(first?.messages)).toEqual([]);
    return first?.messages.find((m) => m.role === 'tool');
  };

  it('answers a metric question with the analytics tools, stores it and meters it', async () => {
    const id = randomUUID();
    const r = await h.ask(owner(), id, 'What is our velocity?');
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toBe('The average velocity of DEMO Scrum is 19 points per sprint.');
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.title).toBe('What is our velocity?');
    expect(convo?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(
      convo?.messages[1]?.parts.map((p) => p.type).filter((t) => t.startsWith('tool-')),
    ).toEqual(['tool-list_boards', 'tool-get_metric']);
    // Exactly one usage row per turn, holding every model call of it.
    const usageRows = await h.rawDb
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.conversationId, id));
    expect(usageRows).toHaveLength(1);
    const [usage] = usageRows;
    // 3 model calls × (120 in, 30 out); 3 and 15 per million tokens.
    expect(usage).toMatchObject({ inputTokens: 360, outputTokens: 90, costMicros: 2430 });
    // The model saw the analytics results as untrusted data.
    const toolMessage = h.llm.requests.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(contentOf(toolMessage)).toMatch(/^<data source="list_boards">\n/);
  });

  it('answers with the model picked for the conversation, else with the default', async () => {
    const created = await createLlmConnection(h.deps, owner(), {
      label: 'Second',
      config: {
        provider: 'openai_compatible',
        model: 'mock-2',
        baseUrl: h.llm.baseUrl,
        apiKey: 'good-key',
      },
    });
    if (!created.ok) throw new Error(created.code);
    const second = created.connection.id;
    // Priced like the default: the spend tests below expect every reply priced.
    await setLlmConnectionPrices(h.deps, owner(), second, {
      inputMicros: 3_000_000,
      outputMicros: 15_000_000,
    });
    const id = randomUUID();
    expect(await setConversationModel(h.db, owner(), id, second)).toBe('ok');
    const modelsUsed = async () =>
      (
        await h.rawDb
          .select({ model: agentUsage.model, connection: agentUsage.llmConnectionId })
          .from(agentUsage)
          .where(eq(agentUsage.conversationId, id))
          .orderBy(agentUsage.createdAt)
      ).map((r) => r.model);

    expect((await h.ask(owner(), id, 'What is our velocity?')).status).toBe(200);
    expect(await modelsUsed()).toEqual(['mock-2']);
    // A model failing its check is skipped: the default answers.
    await h.rawDb
      .update(llmConnections)
      .set({ status: 'error' })
      .where(eq(llmConnections.id, second));
    expect((await h.ask(owner(), id, 'What is our velocity?')).status).toBe(200);
    expect(await modelsUsed()).toEqual(['mock-2', 'mock']);
    await h.rawDb.delete(llmConnections).where(eq(llmConnections.id, second));
  });

  it('a new question brings an archived conversation back', async () => {
    const id = randomUUID();
    expect((await h.ask(owner(), id, 'What is our velocity?')).status).toBe(200);
    expect(await setConversationArchived(h.db, owner(), id, true)).toBe(true);
    expect((await h.ask(owner(), id, 'And the throughput?')).status).toBe(200);
    expect((await loadConversation(h.db, owner(), id))?.archived).toBe(false);
  });

  it('ends with an answer when the model would keep calling tools past the step limit', async () => {
    const id = randomUUID();
    const before = h.llm.requests.length;
    const r = await h.ask(owner(), id, 'Keep searching until you find it');
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toBe('Here is what I found so far.');
    const calls = h.llm.requests.slice(before);
    // 12 model calls: 11 with tools, the last one without any.
    expect(calls).toHaveLength(12);
    expect(calls.slice(0, 11).every((c) => c.tools.includes('list_boards'))).toBe(true);
    expect(calls.at(-1)?.tools).toEqual([]);
    const convo = await loadConversation(h.db, owner(), id);
    const parts = convo?.messages[1]?.parts.map((p) => p.type) ?? [];
    expect(parts.filter((t) => t === 'tool-list_boards')).toHaveLength(11);
    expect(parts.at(-1)).toBe('text');
  });

  it('proposes a Jira comment, writes nothing until approved, then posts it once', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    const proposed = await h.ask(owner(), id, 'Please comment on DEMO-1: Blocked by the API team');
    expect(proposed.chunks.some((c) => c.type === 'tool-approval-request')).toBe(true);
    expect(h.mock.writes).toEqual([]);
    const { approvalId, state } = await approvalPartOf(id);
    expect(state).toBe('approval-requested');

    const approved = await h.send(owner(), {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(approved.status).toBe(200);
    expect(textOf(approved.chunks)).toBe('Done: the comment is posted.');
    expect(h.mock.writes).toMatchObject([
      {
        method: 'POST',
        path: '/rest/api/2/issue/DEMO-1/comment',
        body: { body: 'Blocked by the API team' },
      },
    ]);
    const [row] = await h.rawDb
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.approvalId, approvalId));
    expect(row).toMatchObject({ status: 'executed', resultCode: 'ok', userId: 'user_org_a' });

    // Replaying the decision changes nothing.
    const replay = await h.send(owner(), {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(replay).toMatchObject({ status: 409, error: 'already_decided' });
    expect(h.mock.writes).toHaveLength(1);
    expect(await auditActions()).toEqual(
      expect.arrayContaining([
        'agent_action.proposed',
        'agent_action.approved',
        'agent_action.executed',
      ]),
    );
  });

  it('rejecting a proposal writes nothing and tells the model', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    await h.ask(owner(), id, 'Please comment on DEMO-2: Ready for review');
    const { approvalId } = await approvalPartOf(id);
    const rejected = await h.send(owner(), {
      conversationId: id,
      approvals: [{ approvalId, approved: false }],
    });
    expect(textOf(rejected.chunks)).toBe('Understood, I did not post the comment.');
    expect(h.mock.writes).toEqual([]);
    const [row] = await h.rawDb
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.approvalId, approvalId));
    expect(row?.status).toBe('denied');
    expect(await auditActions()).toContain('agent_action.rejected');
  });

  it('only the user who owns the conversation can decide, and only on real proposals', async () => {
    const id = randomUUID();
    await h.ask(owner(), id, 'Please comment on DEMO-3: Needs a test plan');
    const { approvalId } = await approvalPartOf(id);
    const decide = { conversationId: id, approvals: [{ approvalId, approved: true }] };
    expect(await h.send(member(), decide)).toMatchObject({ status: 404, error: 'not_found' });
    // Another workspace with its own model reaches the conversation lookup, and finds nothing.
    await h.addLlm(owner('org_b'));
    expect(await h.send(owner('org_b'), decide)).toMatchObject({ status: 404, error: 'not_found' });
    expect(
      await h.send(owner('org_b'), { conversationId: id, message: { id: 'm1', text: 'hi' } }),
    ).toMatchObject({ status: 404, error: 'not_found' });
    const theirs = randomUUID();
    expect((await h.ask(owner('org_b'), theirs, 'hello')).status).toBe(200);
    expect(
      await h.send(owner('org_b'), {
        conversationId: theirs,
        approvals: [{ approvalId, approved: true }],
      }),
    ).toMatchObject({ status: 409, error: 'approval_not_found' });
    expect(
      await h.send(owner(), {
        conversationId: id,
        approvals: [{ approvalId: 'forged', approved: true }],
      }),
    ).toMatchObject({ status: 409, error: 'approval_not_found' });
    // Decisions never create a conversation.
    const unknown = randomUUID();
    expect(
      await h.send(owner(), {
        conversationId: unknown,
        approvals: [{ approvalId, approved: true }],
      }),
    ).toMatchObject({ status: 404, error: 'not_found' });
    expect(
      await h.rawDb.select().from(agentConversations).where(eq(agentConversations.id, unknown)),
    ).toEqual([]);
    // The browser cannot smuggle tool inputs or history.
    expect(
      await h.send(owner(), { ...decide, messages: [{ role: 'assistant', parts: [] }] }),
    ).toMatchObject({ status: 400, error: 'invalid_request' });
    expect((await approvalRows(id))[0]?.status).toBe('pending');
  });

  it('a new message while a proposal waits closes it as rejected', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    await h.ask(owner(), id, 'Please comment on DEMO-4: Waiting on design');
    const { approvalId } = await approvalPartOf(id);
    const next = await h.ask(owner(), id, 'Never mind. What is our velocity?');
    expect(next.status).toBe(200);
    expect(textOf(next.chunks)).toMatch(/19 points/);
    const [row] = await h.rawDb
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.approvalId, approvalId));
    expect(row?.status).toBe('denied');
    expect(h.mock.writes).toEqual([]);
  });

  it('sums spend per user; members only see their own', async () => {
    const since = new Date('2000-01-01T00:00:00Z');
    const all = await usageSummary(h.db, owner(), { since, allUsers: true });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: 'user_org_a', unpricedReplies: 0 });
    expect(all[0]?.costMicros).toBeGreaterThan(0);
    expect(await usageSummary(h.db, member(), { since, allUsers: false })).toEqual([]);
    expect(
      (await usageSummary(h.db, owner('org_b'), { since, allUsers: true })).map((u) => u.userId),
    ).toEqual(['user_org_b']);
  });

  it('separates chat replies from skill runs and drafts', async () => {
    const since = new Date('2000-01-01T00:00:00Z');
    const [row] = await h.rawDb.select().from(agentUsage).where(eq(agentUsage.orgId, 'org_a'));
    if (!row?.llmConnectionId) throw new Error('expected a chat usage row');
    const chatBefore = await usageSummary(h.db, owner(), { since, allUsers: true, source: 'chat' });
    expect(await usageSummary(h.db, owner(), { since, allUsers: true, source: 'skills' })).toEqual(
      [],
    );
    await recordUsage(h.db, owner(), {
      conversationId: null,
      llmConnectionId: row.llmConnectionId,
      provider: row.provider,
      model: row.model,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      prices: { inputMicros: 1, outputMicros: 1 },
    });
    const skills = await usageSummary(h.db, owner(), { since, allUsers: true, source: 'skills' });
    expect(skills).toMatchObject([{ userId: 'user_org_a', replies: 1, inputTokens: 10 }]);
    expect(await usageSummary(h.db, owner(), { since, allUsers: true, source: 'chat' })).toEqual(
      chatBefore,
    );
  });

  it('a write tool refuses to run without a recorded approval', async () => {
    await expect(
      claimApprovedExecution(h.db, owner(), {
        conversationId: randomUUID(),
        toolCallId: 'call_x',
        toolName: 'jira_add_comment',
        input: { issueKey: 'DEMO-1', body: 'sneaky' },
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('executes an approved write whose input the schema rewrites (hash parity)', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    await h.ask(owner(), id, 'Please create a padded issue');
    const { approvalId } = await approvalPartOf(id, 'jira_create_issue');
    const approved = await h.send(owner(), {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(approved.status).toBe(200);
    expect(h.mock.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /rest/api/2/issue']);
    expect(JSON.stringify(h.mock.writes[0]?.body)).toContain('"Follow up"');
    const [row] = await approvalRows(id);
    // The proposal and the execution both saw the schema's output (trimmed, unknown key dropped).
    expect(row?.input).toEqual({
      projectKey: 'DEMO',
      summary: 'Follow up',
      issueType: 'Task',
      site: h.connectionId,
    });
    expect(row).toMatchObject({ status: 'executed', resultCode: 'ok' });
  });

  it('members get no live Jira tools, only the analytics tools (P3-R25)', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    const r = await h.ask(member(), id, 'Please comment on DEMO-1: Members cannot write');
    expect(r.status).toBe(200);
    expect(r.chunks.some((c) => c.type === 'tool-approval-request')).toBe(false);
    const sent = h.llm.requests.at(-1);
    // Live Jira reads use the connection owner's credentials and reach beyond the boards an admin
    // shared: owners and admins only, like writes.
    expect(sent?.tools.filter((t) => t.startsWith('jira_'))).toEqual([]);
    expect(sent?.tools).toEqual(
      expect.arrayContaining(['list_boards', 'get_metric', 'forecast', 'find_issues']),
    );
    expect(contentOf(sent?.messages[0])).toContain(
      'Live Jira queries are not available for your role.',
    );
    expect(JSON.stringify(sent?.messages)).not.toContain('<data source="jira_sites">');
    expect(await approvalRows(id)).toEqual([]);
    expect(h.mock.writes).toEqual([]);
  });

  it('binds the Jira site into every proposal, even with one site (P3-R24)', async () => {
    const id = randomUUID();
    await h.ask(owner(), id, 'Please comment on DEMO-7: Site check');
    const { input } = await approvalPartOf(id);
    expect(input).toEqual({ issueKey: 'DEMO-7', body: 'Site check', site: h.connectionId });
    const [row] = await approvalRows(id);
    expect(row?.input).toEqual(input);
    expect(row?.inputHash).toBe(hashInput(input));
    // With one site the model never chooses it: the schema it sees has no `site`.
    const tools = jiraTools(h.deps, owner(), id, [
      {
        id: h.connectionId,
        name: 'Corp Jira',
        deployment: 'datacenter',
        authType: 'pat',
        usable: true,
      },
    ]);
    const schema = (await asSchema(tools.jira_add_comment?.inputSchema).jsonSchema) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['body', 'issueKey']);
  });

  it('never sends an approved change to another site than the one it names (P3-R24)', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    const mcpCalls = h.mcp.calls.length;
    await h.ask(owner(), id, 'Please comment on DEMO-8: Old site');
    const { approvalId, input } = await approvalPartOf(id);
    // As if the proposal was made for a connection since deleted (e.g. replaced by a reconnect).
    const gone = { ...(input as Record<string, unknown>), site: randomUUID() };
    await rewriteProposal(id, approvalId, gone);
    const r = await h.send(owner(), {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(r.status).toBe(200);
    expect(h.mock.writes).toEqual([]);
    expect(h.mcp.calls.length).toBe(mcpCalls);
    // The SDK re-validates the approved input against today's tools: the site no longer matches,
    // so the call never reaches `execute`, and the change is closed as not sent.
    expect((await approvalRows(id))[0]).toMatchObject({
      status: 'failed',
      resultCode: 'not_executed',
    });
    await expectNextMessageWorks(id);
  });

  it('closes an approved row a refusal stops before the claim (M1)', async () => {
    const id = randomUUID();
    await h.ask(owner(), id, 'Please comment on DEMO-9: Refused');
    const { approvalId, input } = await approvalPartOf(id);
    await h.rawDb
      .update(agentApprovals)
      .set({ status: 'approved' })
      .where(eq(agentApprovals.approvalId, approvalId));
    const [row] = await approvalRows(id);
    // The tools of a later turn, when the proposal's site is no longer a connection.
    const tools = jiraTools(h.deps, owner(), id, [
      { id: randomUUID(), name: 'Other', deployment: 'cloud', authType: 'basic', usable: true },
    ]);
    const err = await tools.jira_add_comment
      ?.execute?.(input as never, { toolCallId: row?.toolCallId ?? '', messages: [], context: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentToolError);
    expect((err as AgentToolError).message).toBe(toolErrorText('not_found'));
    expect((await approvalRows(id))[0]).toMatchObject({
      status: 'failed',
      resultCode: 'not_found',
    });
    expect(await auditActionsOf(approvalId)).toContain('agent_action.failed');
  });

  describe('an approvals turn that fails before its change ran (P3-R26)', () => {
    /**
     * Proposes a comment, then approves it with `deps`; `fault` (if any) is armed between the two
     * and always disarmed afterwards.
     */
    async function approveWith(
      text: string,
      deps: AgentDeps,
      fault?: { arm: () => Promise<unknown>; disarm: () => Promise<unknown> },
    ) {
      const id = randomUUID();
      await h.ask(owner(), id, `Please comment on ${text}`);
      const { approvalId } = await approvalPartOf(id);
      h.mock.writes.length = 0;
      const decide = { conversationId: id, approvals: [{ approvalId, approved: true }] };
      await fault?.arm();
      try {
        const result = await h.sendWith(deps, owner(), decide).catch((e: unknown) => e);
        return { id, approvalId, decide, result };
      } finally {
        await fault?.disarm();
      }
    }

    /** Not sent, closed, audited, stored with a result; a retry is refused; the chat goes on. */
    async function expectClosedNotSent(
      id: string,
      approvalId: string,
      decide: Record<string, unknown>,
    ) {
      expect(h.mock.writes).toEqual([]);
      expect((await approvalRows(id))[0]).toMatchObject({
        status: 'failed',
        resultCode: 'not_executed',
      });
      expect(await auditActionsOf(approvalId)).toEqual([
        'agent_action.proposed',
        'agent_action.approved',
        'agent_action.failed',
      ]);
      const part = (await loadConversation(h.db, owner(), id))?.messages
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'tool-jira_add_comment') as { state: string; errorText?: string };
      expect(part).toMatchObject({ state: 'output-error', errorText: NOT_SENT });
      expect(await h.send(owner(), decide)).toMatchObject({
        status: 409,
        error: 'already_decided',
      });
      const tool = await expectNextMessageWorks(id);
      expect(contentOf(tool)).toContain(NOT_SENT);
    }

    it('when the tools cannot be built', async () => {
      const run = await approveWith('DEMO-10: Tools down', h.deps, {
        arm: () => h.rawDb.execute(sql`revoke select on jira_connections from app_user`),
        disarm: () => h.rawDb.execute(sql`grant select on jira_connections to app_user`),
      });
      expect(run.result).toBeInstanceOf(Error);
      await expectClosedNotSent(run.id, run.approvalId, run.decide);
    });

    it('when the model cannot be created', async () => {
      const run = await approveWith('DEMO-11: No model', {
        ...h.deps,
        createModel: () => {
          throw new Error('model setup failed');
        },
      });
      expect(run.result).toBeInstanceOf(Error);
      await expectClosedNotSent(run.id, run.approvalId, run.decide);
    });

    it('when the stream fails before the change is sent (claim error, M2)', async () => {
      const run = await approveWith('DEMO-12: Claim fails', h.deps, {
        arm: async () => {
          await h.rawDb.execute(sql`
            create or replace function test_fail_claim() returns trigger language plpgsql as $$
            begin
              if new.status = 'executed' then raise exception 'claim broken: secret detail'; end if;
              return new;
            end $$`);
          await h.rawDb.execute(sql`
            create trigger test_fail_claim before update on agent_approvals
            for each row execute function test_fail_claim()`);
        },
        disarm: async () => {
          await h.rawDb.execute(sql`drop trigger test_fail_claim on agent_approvals`);
          await h.rawDb.execute(sql`drop function test_fail_claim()`);
        },
      });
      expect(run.result).toMatchObject({ status: 200 });
      // The model was told a fixed sentence, never the database's text.
      const toolMessage = h.llm.requests.at(-1)?.messages.find((m) => m.role === 'tool');
      expect(contentOf(toolMessage)).toContain('The Jira request failed (jira_error).');
      expect(JSON.stringify(h.llm.requests.at(-1)?.messages)).not.toContain('secret detail');
      await expectClosedNotSent(run.id, run.approvalId, run.decide);
    });

    it('when storing the reply fails after the change was sent', async () => {
      const errors: string[] = [];
      const run = await approveWith(
        'DEMO-13: Stored later',
        { ...h.deps, onError: (_e, code) => errors.push(code) },
        {
          arm: async () => {
            await h.rawDb.execute(sql`
              create or replace function test_fail_store() returns trigger language plpgsql as $$
              begin
                if new.parts::text like '%Done: the comment is posted%' then
                  raise exception 'store broken';
                end if;
                return new;
              end $$`);
            await h.rawDb.execute(sql`
              create trigger test_fail_store before insert on agent_messages
              for each row execute function test_fail_store()`);
          },
          disarm: async () => {
            await waitFor(async () => errors.includes('persist_failed'));
            await h.rawDb.execute(sql`drop trigger test_fail_store on agent_messages`);
            await h.rawDb.execute(sql`drop function test_fail_store()`);
          },
        },
      );
      // The comment was posted once; the stored history says so, with a result for the call.
      expect(h.mock.writes.map((w) => w.path)).toEqual(['/rest/api/2/issue/DEMO-13/comment']);
      expect((await approvalRows(run.id))[0]).toMatchObject({
        status: 'executed',
        resultCode: 'ok',
      });
      const part = (await loadConversation(h.db, owner(), run.id))?.messages
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'tool-jira_add_comment') as { state: string };
      expect(part.state).toBe('output-available');
      await expectNextMessageWorks(run.id);
      expect(h.mock.writes).toHaveLength(1);
    });

    it('repairs a conversation an earlier failure left stuck', async () => {
      const id = randomUUID();
      await h.ask(owner(), id, 'Please comment on DEMO-14: Stuck');
      const { approvalId } = await approvalPartOf(id);
      // The state an approvals turn used to leave behind: decided, never run, no result.
      await h.rawDb
        .update(agentApprovals)
        .set({ status: 'approved' })
        .where(eq(agentApprovals.approvalId, approvalId));
      await rewritePart(id, (p) => ({
        ...p,
        state: 'approval-responded',
        approval: { id: approvalId, approved: true },
      }));
      h.mock.writes.length = 0;
      const tool = await expectNextMessageWorks(id);
      expect(contentOf(tool)).toContain(NOT_SENT);
      expect((await approvalRows(id))[0]).toMatchObject({
        status: 'failed',
        resultCode: 'not_executed',
      });
      expect(h.mock.writes).toEqual([]);
    });
  });

  it('records proposals whose tool call ids repeat, and runs only the approved one (M3)', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    const propose = (body: string) => [
      { type: 'stream-start', warnings: [] },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'jira_add_comment',
        input: JSON.stringify({ issueKey: 'DEMO-15', body }),
      },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: usageOf(1, 1),
      },
    ];
    const createModel = scriptedModel([
      propose('First'),
      propose('Second'),
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Posted.' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usageOf(1, 1) },
      ],
    ]);
    const deps = { ...h.deps, createModel };
    const ask = (text: string) =>
      h.sendWith(deps, owner(), { conversationId: id, message: { id: randomUUID(), text } });
    await ask('first');
    await ask('second');
    const rows = await approvalRows(id);
    expect(rows.map((r) => [r.toolCallId, r.status]).sort()).toEqual([
      ['call_1', 'denied'],
      ['call_1', 'pending'],
    ]);
    const second = rows.find((r) => r.status === 'pending');
    const r = await h.sendWith(deps, owner(), {
      conversationId: id,
      approvals: [{ approvalId: second?.approvalId ?? '', approved: true }],
    });
    expect(r.status).toBe(200);
    expect(h.mock.writes.map((w) => w.body)).toEqual([{ body: 'Second' }]);
  });

  it('shows failed analytics calls as errors, with the hint as data (M6)', async () => {
    const analytics = await analyticsTools(h.deps, owner());
    try {
      const run = (input: unknown) =>
        analytics.tools.get_metric
          ?.execute?.(input as never, { toolCallId: 't', messages: [], context: {} })
          .catch((e: unknown) => e);
      const unknown = await run({ boardId: randomUUID(), metric: 'average_velocity' });
      expect(unknown).toBeInstanceOf(AgentToolError);
      expect((unknown as AgentToolError).code).toBe('unknown_board');
      expect((unknown as Error).message).toMatch(
        /^The analytics tool failed \(unknown_board\)\.\n<data source="get_metric_error">/,
      );
      expect((unknown as Error).message).toContain('list_boards');
      const [board] = await h.rawDb.select({ id: jiraBoardsTable.id }).from(jiraBoardsTable);
      const invalid = await run({
        boardId: board?.id,
        metric: 'average_velocity',
        params: { sprints: -3 },
      });
      expect((invalid as AgentToolError).code).toBe('invalid_params');
    } finally {
      await analytics.close();
    }
  });

  it('serialises turns of one conversation: a concurrent message gets 409 turn_in_progress', async () => {
    const id = randomUUID();
    const results = await Promise.all([
      h.ask(owner(), id, 'What is our velocity?'),
      h.ask(owner(), id, 'What is our velocity, again?'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.error).toBe('turn_in_progress');
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Once the turn ended, the conversation takes the next message.
    expect((await h.ask(owner(), id, 'Thanks')).status).toBe(200);
    const after = await loadConversation(h.db, owner(), id);
    expect(after?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('a turn that lost its conversation stops and stores nothing (persist_failed)', async () => {
    const id = randomUUID();
    const g = gatedModel(1);
    const errors: string[] = [];
    const deps: AgentDeps = {
      ...h.deps,
      onError: (_e, code) => errors.push(code),
      createModel: g.createModel,
    };
    const before = h.llm.requests.length;
    const res = await handleAgentRequest(deps, owner(), {
      conversationId: id,
      message: { id: 'm1', text: 'What is our velocity?' },
    });
    await h.rawDb
      .update(agentConversations)
      .set({ turnId: randomUUID() })
      .where(eq(agentConversations.id, id));
    g.open();
    await res.text().catch(() => '');
    await waitFor(async () => errors.includes('persist_failed'));
    // Aborted after its first step: the model was not called again.
    expect(h.llm.requests.length - before).toBe(1);
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('a closed tab does not cut the turn: the full reply is stored, then the lease ends', async () => {
    const id = randomUUID();
    const g = gatedModel(2);
    const res = await handleAgentRequest({ ...h.deps, createModel: g.createModel }, owner(), {
      conversationId: id,
      message: { id: 'm1', text: 'What is our velocity?' },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await g.reached;
    await new Promise((r) => setTimeout(r, 100));
    const lease = async () =>
      (
        await h.rawDb
          .select({ turnId: agentConversations.turnId })
          .from(agentConversations)
          .where(eq(agentConversations.id, id))
      )[0]?.turnId ?? null;
    // Still running: the lease is held and no partial reply is stored.
    expect(await lease()).not.toBeNull();
    expect((await loadConversation(h.db, owner(), id))?.messages.map((m) => m.role)).toEqual([
      'user',
    ]);
    g.open();
    await waitFor(async () => (await lease()) === null);
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const parts = (convo?.messages[1]?.parts ?? []) as { type: string; state?: string }[];
    expect(parts.filter((p) => p.type.startsWith('tool-')).map((p) => [p.type, p.state])).toEqual([
      ['tool-list_boards', 'output-available'],
      ['tool-get_metric', 'output-available'],
    ]);
    expect(JSON.stringify(parts)).toContain('19 points');
    expect((await h.ask(owner(), id, 'Thanks')).status).toBe(200);
  });

  it('meters the steps that finished when a later model call fails', async () => {
    const id = randomUUID();
    const r = await h.ask(owner(), id, 'What is our velocity? Answer, then break');
    expect(r.status).toBe(200);
    // Exactly one usage row per turn, holding every model call of it.
    const usageRows = await h.rawDb
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.conversationId, id));
    expect(usageRows).toHaveLength(1);
    const [usage] = usageRows;
    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 30, costMicros: 810 });
  });

  it('meters the steps that finished when the stream reports an error mid-way', async () => {
    const id = randomUUID();
    const createModel = scriptedModel([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'list_boards', input: '{}' },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: usageOf(120, 30),
        },
      ],
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Partial' },
        { type: 'error', error: new Error('provider dropped the stream') },
      ],
    ]);
    const r = await h.sendWith({ ...h.deps, createModel }, owner(), {
      conversationId: id,
      message: { id: 'm1', text: 'hello' },
    });
    expect(r.status).toBe(200);
    // Exactly one usage row per turn, holding every model call of it.
    const usageRows = await h.rawDb
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.conversationId, id));
    expect(usageRows).toHaveLength(1);
    const [usage] = usageRows;
    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });

  it('a cost overflow does not fail the turn', async () => {
    const id = randomUUID();
    const errors: string[] = [];
    const createModel = scriptedModel([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Expensive answer.' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: usageOf(Number.MAX_SAFE_INTEGER, 1),
        },
      ],
    ]);
    const r = await h.sendWith(
      { ...h.deps, createModel, onError: (_e, code) => errors.push(code) },
      owner(),
      { conversationId: id, message: { id: 'm1', text: 'hello' } },
    );
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toBe('Expensive answer.');
    expect(errors).toEqual(['usage_not_recorded']);
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('a failing outcome record is logged by code and never hides the Jira error', async () => {
    const id = randomUUID();
    await h.ask(owner(), id, 'Please comment on DEMO-999: Nobody home');
    const { approvalId } = await approvalPartOf(id);
    await h.rawDb.execute(sql`
      create or replace function test_fail_finish() returns trigger language plpgsql as $$
      begin
        if new.result_code is not null then raise exception 'finish broken'; end if;
        return new;
      end $$`);
    await h.rawDb.execute(sql`
      create trigger test_fail_finish before update on agent_approvals
      for each row execute function test_fail_finish()`);
    const logged: unknown[][] = [];
    try {
      const r = await h.sendWith({ ...h.deps, onError: (...args) => logged.push(args) }, owner(), {
        conversationId: id,
        approvals: [{ approvalId, approved: true }],
      });
      expect(r.status).toBe(200);
    } finally {
      await h.rawDb.execute(sql`drop trigger test_fail_finish on agent_approvals`);
      await h.rawDb.execute(sql`drop function test_fail_finish()`);
    }
    expect(logged.map(([, code]) => code)).toEqual(['approval_finish_failed', 'not_found']);
    expect(logged.every((args) => args.length === 2)).toBe(true);
    // The model was told about the Jira failure, not the bookkeeping one.
    const tool = h.llm.requests.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(contentOf(tool)).toContain('The Jira request failed (not_found).');
    expect(contentOf(tool)).not.toContain('finish broken');
  });

  it('shows the model an ambiguous assignee’s candidates as data', async () => {
    const id = randomUUID();
    await h.ask(owner(), id, 'Please assign DEMO-2 to Ale');
    const { approvalId } = await approvalPartOf(id, 'jira_assign_issue');
    await h.send(owner(), { conversationId: id, approvals: [{ approvalId, approved: true }] });
    const tool = h.llm.requests.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(contentOf(tool)).toContain('The Jira request failed (ambiguous_user).');
    expect(contentOf(tool)).toContain('<data source="jira_assign_issue_error">');
    expect(contentOf(tool)).toContain('"candidates":[{"id":"alex","displayName":"Alex Martin"}]');
    expect((await approvalRows(id))[0]).toMatchObject({
      status: 'failed',
      resultCode: 'ambiguous_user',
    });
  });

  it('an owner demoted to viewer after a proposal can only deny it', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    await h.ask(owner(), id, 'Please comment on DEMO-6: Before the demotion');
    const { approvalId } = await approvalPartOf(id);
    const demoted = { ...owner(), roles: ['viewer'] };
    const r = await h.send(demoted, {
      conversationId: id,
      approvals: [{ approvalId, approved: true }],
    });
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toBe('Understood, I did not post the comment.');
    expect(h.mock.writes).toEqual([]);
    expect((await approvalRows(id))[0]?.status).toBe('denied');
    const convo = await loadConversation(h.db, owner(), id);
    const part = convo?.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-jira_add_comment') as {
      approval?: { approved?: boolean; reason?: string };
    };
    expect(part?.approval).toMatchObject({ approved: false });
    expect(part?.approval?.reason).toContain('forbidden_role');
    expect((await h.ask(demoted, id, 'OK, thanks')).status).toBe(200);
  });

  it('reaches a user-supplied model URL only through the pinned outbound fetch', async () => {
    const before = h.llm.requests.length;
    const errors: string[] = [];
    const id = randomUUID();
    const r = await h.sendWith(
      { ...h.deps, allowedPrivateHosts: [], onError: (_e, code) => errors.push(code) },
      owner(),
      { conversationId: id, message: { id: 'm1', text: 'hello' } },
    );
    expect(r.status).toBe(200);
    // 127.0.0.1 is not allowlisted here: the pinned fetch refuses it, the mock sees nothing.
    expect(h.llm.requests.length).toBe(before);
    expect(r.chunks).toContainEqual({
      type: 'error',
      errorText:
        'The assistant could not finish this answer. Check the AI provider connection and try again.',
    });
    expect(errors).toContain('agent_stream');
    // A failed reply still ends its turn: the user can try again at once.
    expect((await h.ask(owner(), id, 'hello again')).status).toBe(200);
  });

  it('sends Jira site names to the model as data, never in the system prompt', async () => {
    // A second site (never called here, so a stored row is enough).
    await h.rawDb.insert(jiraConnections).values({
      id: randomUUID(),
      orgId: 'org_a',
      name: 'Ops Jira',
      deployment: 'datacenter',
      authType: 'pat',
      baseUrl: 'https://jira-ops.example.com',
      secret: 'unused',
      createdBy: 'user_org_a',
    });
    const before = h.llm.requests.length;
    const r = await h.ask(owner(), randomUUID(), 'What is our velocity?');
    expect(textOf(r.chunks)).toMatch(/19 points/);
    const [system, data, catalog, question] = h.llm.requests[before]?.messages ?? [];
    expect(system?.role).toBe('system');
    expect(contentOf(system)).not.toContain('Ops Jira');
    expect(contentOf(system)).not.toContain('Corp Jira');
    expect(data?.role).toBe('user');
    expect(contentOf(data)).toMatch(/^<data source="jira_sites">\n/);
    expect(contentOf(data)).toContain('Ops Jira');
    // Then the skills catalog (Phase 4), also as data.
    expect(contentOf(catalog)).toMatch(/^<data source="skills_catalog">\n/);
    expect(contentOf(question)).toBe('What is our velocity?');
  });
  it('recovers a conversation whose last reply stopped mid-step (calls without results)', async () => {
    const id = randomUUID();
    expect((await h.ask(owner(), id, 'hello')).status).toBe(200);
    const [stored] = await h.rawDb
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.conversationId, id), eq(agentMessages.role, 'assistant')));
    if (!stored) throw new Error('no reply stored');
    // What a stream that died on a malformed call leaves behind: a call with no result.
    await h.rawDb
      .update(agentMessages)
      .set({
        parts: [
          ...(stored.parts as unknown[]),
          {
            type: 'tool-list_boards',
            toolCallId: 'dangling-1',
            state: 'input-available',
            input: {},
          },
        ],
      })
      .where(and(eq(agentMessages.conversationId, id), eq(agentMessages.seq, stored.seq)));
    const r = await h.ask(owner(), id, 'continue');
    expect(r.status).toBe(200);
    expect(r.chunks.filter((c) => c.type === 'error')).toEqual([]);
    const convo = await loadConversation(h.db, owner(), id);
    const closed = convo?.messages
      .flatMap((m) => m.parts)
      .find((p) => (p as { toolCallId?: string }).toolCallId === 'dangling-1');
    expect(closed).toMatchObject({
      state: 'output-error',
      errorText: toolErrorText('interrupted'),
    });
  });
});
