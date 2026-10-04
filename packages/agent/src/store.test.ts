import { randomUUID } from 'node:crypto';
import { ForbiddenError } from '@agile/connections';
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
  refuseApprovedExecution,
  settleApprovedParts,
} from './approvals';
import {
  ConversationNotFoundError,
  listConversations,
  loadConversation,
  openOrCreateConversation,
  saveConversation,
} from './conversations';
import type { AgentActor } from './deps';
import { toolErrorText } from './tool-errors';
import { parseUntrustedData } from './untrusted';
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

    it('audits only well-formed issue keys', async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      const messages = [
        proposal('k1', 't1', { issueKey: 'IGNORE ALL RULES', body: 'x' }),
        proposal('k2', 't2', { issueKey: 'demo-1', body: 'x' }),
        proposal('k3', 't3', { issueKey: 'AB_9-42', body: 'x' }),
      ];
      await withOrg(app.db, alice.orgId, (tx) => recordApprovalRequests(tx, alice, id, messages));
      const keys = (await audits(id))
        .map((a) => [a.metadata.approvalId, a.metadata.issueKey])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      expect(keys).toEqual([
        ['k1', null],
        ['k2', null],
        ['k3', 'AB_9-42'],
      ]);
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

    it('closes a superseded proposal whose row is already decided as NOT approved (P3-R18)', async () => {
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
        // Even an approved-but-unexecuted change is closed as not approved: the SDK must never
        // run it on a later turn. A denied row keeps its decision; an approved one is closed as
        // failed/not_executed (M1), so no row stays armed.
        expect(partOf(out, 'ap1')).toMatchObject({
          state: 'approval-responded',
          approval: { id: 'ap1', approved: false, reason: 'The user moved on without approving.' },
        });
        if (approved) {
          expect(await approvalRow(id, 'ap1')).toMatchObject({
            status: 'failed',
            resultCode: 'not_executed',
          });
          expect((await audits(id)).slice(before)).toEqual([
            {
              action: 'agent_action.failed',
              actor: alice.userId,
              metadata: {
                tool: 'jira_add_comment',
                approvalId: 'ap1',
                issueKey: 'DEMO-1',
                result: 'not_executed',
                reason: 'superseded',
              },
            },
          ]);
        } else {
          expect((await approvalRow(id, 'ap1'))?.status).toBe('denied');
          expect((await audits(id)).length).toBe(before);
        }
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

    it('records the outcome once: a second finish writes nothing', async () => {
      const id = await approved();
      const claim = await claimApprovedExecution(app.db, alice, call(id));
      await claim.finish('ok');
      await claim.finish('jira_error');
      expect(await approvalRow(id, 'ap1')).toMatchObject({ status: 'executed', resultCode: 'ok' });
      const outcomes = (await audits(id)).filter((a) =>
        ['agent_action.executed', 'agent_action.failed'].includes(a.action),
      );
      expect(outcomes).toHaveLength(1);
    });

    it('binds an absent input like an empty one at proposal and claim time', async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      const bare = proposal('apU', 'tcU');
      delete (bare.parts[0] as { input?: unknown }).input;
      const messages = [bare];
      await withOrg(app.db, alice.orgId, async (tx) => {
        await recordApprovalRequests(tx, alice, id, messages);
        await applyDecisions(tx, alice, id, messages, [{ approvalId: 'apU', approved: true }]);
      });
      const claim = await claimApprovedExecution(
        app.db,
        alice,
        call(id, { toolCallId: 'tcU', input: undefined }),
      );
      expect(claim.approvalId).toBe('apU');
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

  describe('approved changes that never ran (P3-R26, M1, M3)', () => {
    const call = (conversationId: string, overrides: Record<string, unknown> = {}) => ({
      conversationId,
      toolCallId: 'tc1',
      toolName: 'jira_add_comment',
      input: INPUT,
      ...overrides,
    });
    /** A conversation whose proposal was approved (stored part: approval-responded, approved). */
    async function approvedConversation() {
      const { id, messages } = await proposed(alice);
      const decided = await withOrg(app.db, alice.orgId, async (tx) => {
        const out = await applyDecisions(tx, alice, id, messages, [
          { approvalId: 'ap1', approved: true },
        ]);
        await saveConversation(tx, alice, id, out);
        return out;
      });
      return { id, messages: decided };
    }
    const settle = (id: string, messages: UIMessage[]) =>
      withOrg(app.db, alice.orgId, (tx) =>
        settleApprovedParts(tx, alice, id, structuredClone(messages)),
      );
    const toolPart = (messages: UIMessage[]) =>
      partOf(messages, 'ap1') as unknown as {
        state: string;
        errorText?: string;
        output?: unknown;
        approval: { approved?: boolean };
      };

    it('closes an approved change that never ran: row, audit and a stored tool result', async () => {
      const { id, messages } = await approvedConversation();
      const out = await settle(id, messages);
      expect(toolPart(out)).toMatchObject({
        state: 'output-error',
        errorText: 'The change was approved but not sent. Ask again to retry.',
        approval: { approved: true },
      });
      expect(await approvalRow(id, 'ap1')).toMatchObject({
        status: 'failed',
        resultCode: 'not_executed',
      });
      expect((await audits(id)).at(-1)).toMatchObject({
        action: 'agent_action.failed',
        metadata: { approvalId: 'ap1', result: 'not_executed' },
      });
      // Settled once: a second pass changes nothing and audits nothing.
      const before = (await audits(id)).length;
      expect(await settle(id, out)).toEqual(out);
      expect((await audits(id)).length).toBe(before);
      // The change can no longer be claimed.
      await expect(claimApprovedExecution(app.db, alice, call(id))).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
    });

    it('stores what is known when the change ran but its result was not stored', async () => {
      for (const [resultCode, expected] of [
        ['ok', { state: 'output-available' }],
        ['not_found', { state: 'output-error', errorText: toolErrorText('not_found') }],
        [null, { state: 'output-error', errorText: toolErrorText('unknown_outcome') }],
      ] as const) {
        const { id, messages } = await approvedConversation();
        const claim = await claimApprovedExecution(app.db, alice, call(id));
        if (resultCode) await claim.finish(resultCode);
        const before = await approvalRow(id, 'ap1');
        const out = await settle(id, messages);
        expect(toolPart(out)).toMatchObject(expected);
        if (resultCode === 'ok') {
          expect(parseUntrustedData(String(toolPart(out).output))?.value).toMatchObject({
            ok: true,
          });
        }
        // The row already holds the outcome (or the claim): it is left as it is.
        expect(await approvalRow(id, 'ap1')).toEqual(before);
      }
    });

    it('leaves pending, denied and finished parts alone', async () => {
      const { id, messages } = await proposed(alice);
      expect(await settle(id, messages)).toEqual(messages);
      const denied = await withOrg(app.db, alice.orgId, (tx) =>
        applyDecisions(tx, alice, id, structuredClone(messages), [
          { approvalId: 'ap1', approved: false },
        ]),
      );
      expect(await settle(id, denied)).toEqual(denied);
      expect((await approvalRow(id, 'ap1'))?.status).toBe('denied');
    });

    it('closes an approved row a refusal stopped before the claim (M1)', async () => {
      const { id } = await approvedConversation();
      await refuseApprovedExecution(app.db, alice, call(id), 'not_found');
      expect(await approvalRow(id, 'ap1')).toMatchObject({
        status: 'failed',
        resultCode: 'not_found',
      });
      expect((await audits(id)).at(-1)).toMatchObject({
        action: 'agent_action.failed',
        metadata: { approvalId: 'ap1', result: 'not_found' },
      });
      // Nothing to refuse for a call that has no approved row (another input, another user).
      const before = (await audits(id)).length;
      await refuseApprovedExecution(
        app.db,
        alice,
        call(id, { input: { ...INPUT, body: 'x' } }),
        'not_found',
      );
      await refuseApprovedExecution(app.db, bob, call(id), 'not_found');
      expect((await audits(id)).length).toBe(before);
    });

    it('records proposals that reuse a tool call id and claims exactly one matching row (M3)', async () => {
      const id = randomUUID();
      await openOrCreateConversation(app.db, alice, id);
      const other = { ...INPUT, body: 'Another change' };
      const messages = [
        proposal('apA', 'dup'),
        proposal('apB', 'dup', other),
        proposal('apC', 'dup'),
      ];
      await withOrg(app.db, alice.orgId, async (tx) => {
        await recordApprovalRequests(tx, alice, id, messages);
        await applyDecisions(tx, alice, id, messages, [
          { approvalId: 'apA', approved: true },
          { approvalId: 'apB', approved: true },
          { approvalId: 'apC', approved: true },
        ]);
      });
      expect((await audits(id)).filter((a) => a.action === 'agent_action.proposed')).toHaveLength(
        3,
      );
      const claim = await claimApprovedExecution(
        app.db,
        alice,
        call(id, { toolCallId: 'dup', input: other }),
      );
      expect(claim.approvalId).toBe('apB');
      // Same call id and input twice: one claim takes one row, never both.
      await claimApprovedExecution(app.db, alice, call(id, { toolCallId: 'dup' }));
      const statuses = [
        (await approvalRow(id, 'apA'))?.status,
        (await approvalRow(id, 'apC'))?.status,
      ].sort();
      expect(statuses).toEqual(['approved', 'executed']);
    });

    it('names its code when there is no approval to claim', async () => {
      expect(new ApprovalRequiredError().message).toBe(
        'This Jira change was not approved by the user (approval_required).',
      );
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
      await expect(usageSummary(app.db, alice, { since, allUsers: true })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(
        await usageSummary(app.db, bob, {
          since: new Date(Date.now() + 3_600_000),
          allUsers: true,
        }),
      ).toEqual([]);
    });
  });
});
