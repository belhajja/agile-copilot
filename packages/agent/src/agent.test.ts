import { randomUUID } from 'node:crypto';
import {
  agentApprovals,
  agentConversations,
  agentUsage,
  auditLog,
  jiraConnections,
} from '@agile/db';
import { createLanguageModel } from '@agile/llm';
import { agentDemoScript, type MockChatMessage, type MockScript } from '@agile/llm/testing';
import { createOutboundFetch } from '@agile/net';
import { member, owner } from '@agile/sync/testing';
import type { LanguageModel } from 'ai';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRequiredError, claimApprovedExecution } from './approvals';
import { loadConversation } from './conversations';
import type { AgentDeps } from './deps';
import { startAgentHarness, textOf } from './test-harness';
import { handleAgentRequest } from './turn';
import { usageSummary } from './usage';

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
  return agentDemoScript(req);
};

const contentOf = (m: MockChatMessage | undefined) =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');

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
    const [usage] = await h.rawDb
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.conversationId, id));
    // 3 model calls × (120 in, 30 out); 3 and 15 per million tokens.
    expect(usage).toMatchObject({ inputTokens: 360, outputTokens: 90, costMicros: 2430 });
    // The model saw the analytics results as untrusted data.
    const toolMessage = h.llm.requests.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(contentOf(toolMessage)).toMatch(/^<data source="list_boards">\n/);
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
    expect(row?.input).toEqual({ projectKey: 'DEMO', summary: 'Follow up', issueType: 'Task' });
    expect(row).toMatchObject({ status: 'executed', resultCode: 'ok' });
  });

  it('members get read-only Jira tools: no write tool, no proposal', async () => {
    const id = randomUUID();
    h.mock.writes.length = 0;
    const r = await h.ask(member(), id, 'Please comment on DEMO-1: Members cannot write');
    expect(r.status).toBe(200);
    expect(r.chunks.some((c) => c.type === 'tool-approval-request')).toBe(false);
    const sent = h.llm.requests.at(-1);
    expect(sent?.tools).toContain('jira_search');
    expect(sent?.tools).not.toContain('jira_add_comment');
    expect(sent?.tools.filter((t) => t.startsWith('jira_'))).toEqual([
      'jira_search',
      'jira_get_issue',
      'jira_get_transitions',
      'jira_get_agile_boards',
      'jira_get_sprints_from_board',
      'jira_get_sprint_issues',
    ]);
    expect(contentOf(sent?.messages[0])).toContain('Jira changes are not available for your role.');
    expect(await approvalRows(id)).toEqual([]);
    expect(h.mock.writes).toEqual([]);
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

  it('does not store a reply whose turn lost its conversation, and reports persist_failed', async () => {
    const id = randomUUID();
    let open = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const errors: string[] = [];
    const deps: AgentDeps = {
      ...h.deps,
      onError: (_e, code) => errors.push(code),
      // The real model, held until the test has taken the conversation's lease away.
      createModel: (config) => {
        const model = createLanguageModel(config, {
          fetch: createOutboundFetch({ allowedPrivateHosts: ['127.0.0.1'] }),
        }) as unknown as { doStream: (o: unknown) => Promise<unknown> };
        return new Proxy(model, {
          get: (target, prop) =>
            prop === 'doStream'
              ? async (o: unknown) => {
                  await gate;
                  return target.doStream(o);
                }
              : Reflect.get(target, prop),
        }) as unknown as LanguageModel;
      },
    };
    const res = await handleAgentRequest(deps, owner(), {
      conversationId: id,
      message: { id: 'm1', text: 'hello' },
    });
    await h.rawDb
      .update(agentConversations)
      .set({ turnId: randomUUID() })
      .where(eq(agentConversations.id, id));
    open();
    await expect(res.text()).rejects.toThrow();
    expect(errors).toContain('persist_failed');
    const convo = await loadConversation(h.db, owner(), id);
    expect(convo?.messages.map((m) => m.role)).toEqual(['user']);
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
    const [system, data, question] = h.llm.requests[before]?.messages ?? [];
    expect(system?.role).toBe('system');
    expect(contentOf(system)).not.toContain('Ops Jira');
    expect(contentOf(system)).not.toContain('Corp Jira');
    expect(data?.role).toBe('user');
    expect(contentOf(data)).toMatch(/^<data source="jira_sites">\n/);
    expect(contentOf(data)).toContain('Ops Jira');
    expect(contentOf(question)).toBe('What is our velocity?');
  });
});
