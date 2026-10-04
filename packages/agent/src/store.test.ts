import { randomUUID } from 'node:crypto';
import { agentApprovals, agentMessages, auditLog, createDb, user, withOrg } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import type { UIMessage } from 'ai';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalRequiredError,
  applyDecisions,
  claimApprovedExecution,
  DecisionError,
  hashInput,
  recordApprovalRequests,
} from './approvals';
import {
  ConversationNotFoundError,
  listConversations,
  loadConversation,
  openOrCreateConversation,
  saveConversation,
} from './conversations';
import type { AgentActor } from './deps';
import { recordUsage, usageSummary } from './usage';

const alice: AgentActor = { orgId: 'org_a', userId: 'user_alice', roles: ['member'] };
const bob: AgentActor = { orgId: 'org_a', userId: 'user_bob', roles: ['owner'] };
const eve: AgentActor = { orgId: 'org_b', userId: 'user_eve', roles: ['owner'] };

const INPUT = { issueKey: 'DEMO-1', body: 'Looks good' };

const userText = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/** An assistant message proposing one Jira comment, waiting for the user. */
const proposal = (approvalId: string, toolCallId: string, input: unknown = INPUT): UIMessage =>
  ({
    id: `m-${approvalId}`,
    role: 'assistant',
    parts: [
      {
        type: 'tool-jira_add_comment',
        toolCallId,
        state: 'approval-requested',
        input,
        approval: { id: approvalId },
      },
    ],
  }) as unknown as UIMessage;

const partOf = (messages: UIMessage[], approvalId: string) =>
  messages
    .flatMap((m) => m.parts as unknown as { approval?: { id: string } }[])
    .find((p) => p.approval?.id === approvalId) as unknown as {
    state: string;
    approval: { id: string; approved?: boolean; reason?: string };
  };

describe('agent store (conversations, approvals, usage) as app_user', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 4 });
    owner = createDb(tdb.ownerUrl, { max: 1 });
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.stop();
  });

  const audits = (conversationId: string) =>
    owner.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.targetId, conversationId))
      .orderBy(asc(auditLog.createdAt));

  const approvalRow = async (conversationId: string, approvalId: string) => {
    const [row] = await owner.db
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.conversationId, conversationId),
          eq(agentApprovals.approvalId, approvalId),
        ),
      );
    return row;
  };

  /** A conversation of `actor` holding one stored pending proposal. */
  async function proposed(actor: AgentActor, approvalId = 'ap1', toolCallId = 'tc1') {
    const id = randomUUID();
    await openOrCreateConversation(app.db, actor, id);
    const messages = [userText('u1', 'Comment on DEMO-1'), proposal(approvalId, toolCallId)];
    await withOrg(app.db, actor.orgId, async (tx) => {
      await saveConversation(tx, actor, id, messages);
      await recordApprovalRequests(tx, actor, id, messages);
    });
    return { id, messages };
  }

  describe('conversations', () => {
    it('creates under the client id, lists and loads only for the owner', async () => {
      const id = randomUUID();
      expect(await openOrCreateConversation(app.db, alice, id)).toEqual({ id, messages: [] });
      const messages = [userText('u1', '  How is\nthe sprint going?  '), userText('u2', 'x')];
      await withOrg(app.db, alice.orgId, (tx) => saveConversation(tx, alice, id, messages));

      const loaded = await loadConversation(app.db, alice, id);
      expect(loaded?.title).toBe('How is the sprint going?');
      expect(loaded?.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
      expect((await listConversations(app.db, alice)).map((c) => c.id)).toContain(id);

      expect(await loadConversation(app.db, bob, id)).toBeNull();
      expect((await listConversations(app.db, bob)).map((c) => c.id)).not.toContain(id);
      expect(await loadConversation(app.db, alice, 'not-a-uuid')).toBeNull();
    });

    it('refuses an id owned by another user or workspace without revealing it', async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      expect(await openOrCreateConversation(app.db, bob, id)).toBeNull();
      expect(await openOrCreateConversation(app.db, eve, id)).toBeNull();
      expect(await openOrCreateConversation(app.db, alice, 'nope')).toBeNull();
    });

    it("never writes messages into someone else's conversation", async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      for (const intruder of [bob, eve]) {
        await expect(
          withOrg(app.db, intruder.orgId, (tx) =>
            saveConversation(tx, intruder, id, [userText('x', 'hijack')]),
          ),
        ).rejects.toBeInstanceOf(ConversationNotFoundError);
      }
      const rows = await owner.db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.conversationId, id));
      expect(rows).toEqual([]);
    });
  });

  describe('approval requests', () => {
    it('stores one pending row per proposal (idempotent) and audits the proposal once', async () => {
      const { id, messages } = await proposed(alice);
      await withOrg(app.db, alice.orgId, (tx) => recordApprovalRequests(tx, alice, id, messages));
      const row = await approvalRow(id, 'ap1');
      expect(row).toMatchObject({
        userId: alice.userId,
        toolCallId: 'tc1',
        toolName: 'jira_add_comment',
        status: 'pending',
        inputHash: hashInput(INPUT),
      });
      const log = await audits(id);
      expect(log).toEqual([
        {
          action: 'agent_action.proposed',
          actor: alice.userId,
          metadata: { tool: 'jira_add_comment', approvalId: 'ap1', issueKey: 'DEMO-1' },
        },
      ]);
      // No comment body in the audit trail.
      expect(JSON.stringify(log)).not.toContain('Looks good');
    });

    it("refuses to record approvals in another user's or workspace's conversation", async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      for (const intruder of [bob, eve]) {
        await expect(
          withOrg(app.db, intruder.orgId, (tx) =>
            recordApprovalRequests(tx, intruder, id, [proposal('apX', 'tcX')]),
          ),
        ).rejects.toBeInstanceOf(ConversationNotFoundError);
      }
      expect(await approvalRow(id, 'apX')).toBeUndefined();
    });
  });

  describe('decisions (P3-R1)', () => {
    it('approves a pending proposal: row, audit and message part', async () => {
      const { id, messages } = await proposed(alice);
      const out = await withOrg(app.db, alice.orgId, (tx) =>
        applyDecisions(tx, alice, id, messages, [{ approvalId: 'ap1', approved: true }]),
      );
      expect(partOf(out, 'ap1')).toMatchObject({
        state: 'approval-responded',
        approval: { id: 'ap1', approved: true },
      });
      expect((await approvalRow(id, 'ap1'))?.status).toBe('approved');
      expect((await audits(id)).map((a) => a.action)).toEqual([
        'agent_action.proposed',
        'agent_action.approved',
      ]);
    });

    it('throws already_decided on a replay and rolls the whole transaction back', async () => {
      const { id, messages } = await proposed(alice);
      await withOrg(app.db, alice.orgId, (tx) =>
        applyDecisions(tx, alice, id, structuredClone(messages), [
          { approvalId: 'ap1', approved: false },
        ]),
      );
      const replay = withOrg(app.db, alice.orgId, (tx) =>
        applyDecisions(tx, alice, id, structuredClone(messages), [
          { approvalId: 'ap1', approved: true },
        ]),
      );
      await expect(replay).rejects.toBeInstanceOf(DecisionError);
      await expect(replay).rejects.toMatchObject({ code: 'already_decided' });
      expect((await approvalRow(id, 'ap1'))?.status).toBe('denied');
    });

    it('rolls back earlier decisions of the same request when a later one fails', async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      const messages = [proposal('apA', 'tcA'), proposal('apB', 'tcB')];
      await withOrg(app.db, alice.orgId, (tx) => recordApprovalRequests(tx, alice, id, messages));
      await expect(
        withOrg(app.db, alice.orgId, (tx) =>
          applyDecisions(tx, alice, id, messages, [
            { approvalId: 'apA', approved: true },
            { approvalId: 'forged', approved: true },
          ]),
        ),
      ).rejects.toMatchObject({ code: 'approval_not_found' });
      expect((await approvalRow(id, 'apA'))?.status).toBe('pending');
      expect((await audits(id)).map((a) => a.action)).not.toContain('agent_action.approved');
    });

    it('rejects a double decision inside one request', async () => {
      const { id, messages } = await proposed(alice);
      await expect(
        withOrg(app.db, alice.orgId, (tx) =>
          applyDecisions(tx, alice, id, messages, [
            { approvalId: 'ap1', approved: true },
            { approvalId: 'ap1', approved: true },
          ]),
        ),
      ).rejects.toMatchObject({ code: 'already_decided' });
      expect((await approvalRow(id, 'ap1'))?.status).toBe('pending');
    });

    it("throws for another user's approval and for a tampered input", async () => {
      const { id, messages } = await proposed(alice);
      await expect(
        withOrg(app.db, bob.orgId, (tx) =>
          applyDecisions(tx, bob, id, messages, [{ approvalId: 'ap1', approved: true }]),
        ),
      ).rejects.toBeInstanceOf(ConversationNotFoundError);
      const tampered = [userText('u1', 'x'), proposal('ap1', 'tc1', { ...INPUT, body: 'Evil' })];
      await expect(
        withOrg(app.db, alice.orgId, (tx) =>
          applyDecisions(tx, alice, id, tampered, [{ approvalId: 'ap1', approved: true }]),
        ),
      ).rejects.toMatchObject({ code: 'approval_not_found' });
      expect((await approvalRow(id, 'ap1'))?.status).toBe('pending');
    });

    it('closes a superseded pending proposal as rejected (audited with the reason)', async () => {
      const { id, messages } = await proposed(alice);
      const out = await withOrg(app.db, alice.orgId, (tx) =>
        applyDecisions(tx, alice, id, messages, [
          { approvalId: 'ap1', approved: false, reason: 'superseded' },
        ]),
      );
      expect(partOf(out, 'ap1')).toMatchObject({
        state: 'approval-responded',
        approval: { approved: false },
      });
      expect((await approvalRow(id, 'ap1'))?.status).toBe('denied');
      const last = (await audits(id)).at(-1);
      expect(last).toMatchObject({
        action: 'agent_action.rejected',
        metadata: { reason: 'superseded' },
      });
    });

    it('treats a superseded proposal whose row is already decided as closed', async () => {
      for (const approved of [true, false]) {
        const { id, messages } = await proposed(alice);
        // The decision was stored but the message still shows the request.
        await withOrg(app.db, alice.orgId, (tx) =>
          applyDecisions(tx, alice, id, structuredClone(messages), [
            { approvalId: 'ap1', approved },
          ]),
        );
        const before = (await audits(id)).length;
        const out = await withOrg(app.db, alice.orgId, (tx) =>
          applyDecisions(tx, alice, id, messages, [
            { approvalId: 'ap1', approved: false, reason: 'superseded' },
          ]),
        );
        expect(partOf(out, 'ap1')).toMatchObject({
          state: 'approval-responded',
          approval: { id: 'ap1', approved },
        });
        expect((await approvalRow(id, 'ap1'))?.status).toBe(approved ? 'approved' : 'denied');
        expect((await audits(id)).length).toBe(before);
      }
    });

    it('closes a superseded proposal that never got a row, audited as not recorded', async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      const messages = [proposal('ghost', 'tcG')];
      const out = await withOrg(app.db, alice.orgId, (tx) =>
        applyDecisions(tx, alice, id, messages, [
          { approvalId: 'ghost', approved: false, reason: 'superseded' },
        ]),
      );
      expect(partOf(out, 'ghost')).toMatchObject({
        state: 'approval-responded',
        approval: { approved: false },
      });
      expect(await approvalRow(id, 'ghost')).toBeUndefined();
      expect(await audits(id)).toEqual([
        {
          action: 'agent_action.rejected',
          actor: alice.userId,
          metadata: {
            tool: 'jira_add_comment',
            approvalId: 'ghost',
            issueKey: 'DEMO-1',
            reason: 'superseded',
            recorded: false,
          },
        },
      ]);
    });
  });

  describe('execution claim (P3-R1 d)', () => {
    const call = (conversationId: string, overrides: Record<string, unknown> = {}) => ({
      conversationId,
      toolCallId: 'tc1',
      toolName: 'jira_add_comment',
      input: { body: 'Looks good', issueKey: 'DEMO-1' },
      ...overrides,
    });

    async function approved(actor = alice) {
      const { id, messages } = await proposed(actor);
      await withOrg(app.db, actor.orgId, (tx) =>
        applyDecisions(tx, actor, id, messages, [{ approvalId: 'ap1', approved: true }]),
      );
      return id;
    }

    it('claims an approved call once, then records the outcome', async () => {
      const id = await approved();
      const claim = await claimApprovedExecution(app.db, alice, call(id));
      expect(claim.approvalId).toBe('ap1');
      expect((await approvalRow(id, 'ap1'))?.status).toBe('executed');
      await expect(claimApprovedExecution(app.db, alice, call(id))).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
      await claim.finish('ok');
      expect(await approvalRow(id, 'ap1')).toMatchObject({ status: 'executed', resultCode: 'ok' });
      expect((await audits(id)).at(-1)).toMatchObject({
        action: 'agent_action.executed',
        metadata: { result: 'ok', approvalId: 'ap1' },
      });
    });

    it('marks a failed write failed', async () => {
      const id = await approved();
      const claim = await claimApprovedExecution(app.db, alice, call(id));
      await claim.finish('forbidden');
      expect(await approvalRow(id, 'ap1')).toMatchObject({
        status: 'failed',
        resultCode: 'forbidden',
      });
      expect((await audits(id)).at(-1)?.action).toBe('agent_action.failed');
    });

    it('throws without an approved row matching user, conversation, call, tool and input', async () => {
      const id = await approved();
      const mismatches = [
        { actor: bob, call: call(id) },
        { actor: eve, call: call(id) },
        { actor: alice, call: call(randomUUID()) },
        { actor: alice, call: call(id, { toolCallId: 'tc2' }) },
        { actor: alice, call: call(id, { toolName: 'jira_assign_issue' }) },
        { actor: alice, call: call(id, { input: { ...INPUT, body: 'Changed' } }) },
      ];
      for (const m of mismatches) {
        await expect(claimApprovedExecution(app.db, m.actor, m.call)).rejects.toBeInstanceOf(
          ApprovalRequiredError,
        );
      }
      expect((await approvalRow(id, 'ap1'))?.status).toBe('approved');

      // A pending (never approved) row cannot be claimed either.
      const pending = await proposed(alice);
      await expect(claimApprovedExecution(app.db, alice, call(pending.id))).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
    });

    it('lets exactly one of two concurrent claims through', async () => {
      const id = await approved();
      const results = await Promise.allSettled([
        claimApprovedExecution(app.db, alice, call(id)),
        claimApprovedExecution(app.db, alice, call(id)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('usage (P3-R13)', () => {
    it('sums per user beyond 32 bits, prices only known costs, and scopes to the actor', async () => {
      await owner.db.insert(user).values({
        id: 'user_bob',
        name: 'Bob',
        email: 'bob@example.test',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const since = new Date(Date.now() - 60_000);
      const big = { inputTokens: 2_000_000_000, outputTokens: 1_500_000_000, cachedInputTokens: 0 };
      const entry = {
        conversationId: randomUUID(),
        llmConnectionId: randomUUID(),
        provider: 'openai',
        model: 'gpt-test',
      };
      const prices = { inputMicros: 3_000_000, outputMicros: 15_000_000 };
      await recordUsage(app.db, bob, { ...entry, usage: big, prices });
      await recordUsage(app.db, bob, { ...entry, usage: big, prices });
      await recordUsage(app.db, bob, {
        ...entry,
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
        prices: { inputMicros: null, outputMicros: 15_000_000 },
      });
      await recordUsage(app.db, alice, {
        ...entry,
        usage: { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0 },
        prices,
      });
      await recordUsage(app.db, eve, { ...entry, usage: big, prices });

      const mine = await usageSummary(app.db, bob, { since, allUsers: false });
      expect(mine).toEqual([
        {
          userId: 'user_bob',
          name: 'Bob',
          replies: 3,
          inputTokens: 4_000_000_010,
          outputTokens: 3_000_000_005,
          costMicros: 2 * (6_000_000_000 + 22_500_000_000),
          unpricedReplies: 1,
        },
      ]);
      const all = await usageSummary(app.db, bob, { since, allUsers: true });
      expect(all.map((r) => r.userId).sort()).toEqual(['user_alice', 'user_bob']);
      expect(all.find((r) => r.userId === 'user_alice')).toMatchObject({
        name: null,
        replies: 1,
        costMicros: 10_500,
      });
      expect(
        await usageSummary(app.db, bob, {
          since: new Date(Date.now() + 3_600_000),
          allUsers: true,
        }),
      ).toEqual([]);
    });
  });
});
