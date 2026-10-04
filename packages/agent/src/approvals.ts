import { createHash } from 'node:crypto';
import { recordAudit } from '@agile/connections';
import { agentApprovals, type Db, type Tx, withOrg } from '@agile/db';
import { isJiraWriteTool } from '@agile/jira-tools';
import type { UIMessage } from 'ai';
import { and, eq } from 'drizzle-orm';
import { requireOwnConversation } from './conversations';
import type { AgentActor } from './deps';

/** Canonical JSON (sorted keys) → sha256. Binds an approval to the exact tool input. */
export function hashInput(input: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
}

interface ApprovalPart {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean; reason?: string };
}

const toolNameOf = (part: { type: string }) =>
  part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : null;

/** Tool parts of Jira writes waiting for the user (in the order the model proposed them). */
export function pendingApprovalParts(messages: UIMessage[]): ApprovalPart[] {
  return messages.flatMap((m) =>
    m.role !== 'assistant'
      ? []
      : (m.parts as unknown as ApprovalPart[]).filter((p) => {
          const name = toolNameOf(p);
          return (
            p.state === 'approval-requested' &&
            name !== null &&
            isJiraWriteTool(name) &&
            typeof p.approval?.id === 'string'
          );
        }),
  );
}

const issueKeyOf = (input: unknown) => {
  const key = (input as { issueKey?: unknown } | null)?.issueKey;
  return typeof key === 'string' ? key : null;
};

/** Closes a proposal in the stored messages (the AI SDK then runs or skips the tool call). */
function respond(part: ApprovalPart, approvalId: string, approved: boolean, superseded: boolean) {
  part.state = 'approval-responded';
  part.approval = {
    ...part.approval,
    id: approvalId,
    approved,
    ...(superseded ? { reason: 'The user moved on without approving.' } : {}),
  };
}

/**
 * Stores a pending approval for every new approval request (idempotent) and audits the proposal.
 * Throws `ConversationNotFoundError` unless the actor owns the conversation.
 */
export async function recordApprovalRequests(
  tx: Tx,
  actor: AgentActor,
  conversationId: string,
  messages: UIMessage[],
): Promise<void> {
  const parts = pendingApprovalParts(messages);
  if (parts.length === 0) return;
  // The FK names only the conversation and bypasses RLS: check tenant and owner first.
  await requireOwnConversation(tx, actor, conversationId);
  for (const part of parts) {
    const approvalId = part.approval?.id ?? '';
    const toolName = toolNameOf(part) ?? '';
    const inserted = await tx
      .insert(agentApprovals)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        conversationId,
        approvalId,
        toolCallId: part.toolCallId,
        toolName,
        input: (part.input ?? {}) as Record<string, unknown>,
        inputHash: hashInput(part.input ?? {}),
      })
      .onConflictDoNothing()
      .returning({ id: agentApprovals.id });
    if (inserted.length === 0) continue;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'agent_action.proposed',
      targetType: 'agent_conversation',
      targetId: conversationId,
      metadata: { tool: toolName, approvalId, issueKey: issueKeyOf(part.input) },
    });
  }
}

export type DecisionFailure = 'approval_not_found' | 'already_decided';

/**
 * A decision that cannot be applied. Thrown (not returned) so the caller's whole `withOrg`
 * transaction rolls back: no earlier decision of the same request is kept.
 */
export class DecisionError extends Error {
  override name = 'DecisionError';
  constructor(readonly code: DecisionFailure) {
    super(`Approval decision refused: ${code}`);
  }
}

/**
 * Applies the user's decisions to the stored messages, inside the caller's transaction, and
 * returns the updated messages. Each decision must name a pending approval of THIS user in THIS
 * conversation whose stored input still hashes to what was proposed; it is recorded (and audited)
 * once. Nothing from the browser but the approval id and the yes/no is used. Throws
 * `DecisionError` (or `ConversationNotFoundError`) otherwise.
 *
 * `reason: 'superseded'` closes proposals the user moved past: a pending row is denied, a row
 * already decided is left as it is (the part just mirrors it), and a proposal that never got a
 * row (its stream was not stored) is closed and audited as rejected, `recorded: false`.
 */
export async function applyDecisions(
  tx: Tx,
  actor: AgentActor,
  conversationId: string,
  messages: UIMessage[],
  decisions: { approvalId: string; approved: boolean; reason?: 'superseded' }[],
): Promise<UIMessage[]> {
  await requireOwnConversation(tx, actor, conversationId);
  const parts = new Map(pendingApprovalParts(messages).map((p) => [p.approval?.id ?? '', p]));
  for (const d of decisions) {
    const part = parts.get(d.approvalId);
    const superseded = d.reason === 'superseded';
    const [row] = await tx
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.conversationId, conversationId),
          eq(agentApprovals.approvalId, d.approvalId),
          eq(agentApprovals.userId, actor.userId),
        ),
      )
      .for('update');
    if (superseded && part && row?.status !== 'pending') {
      if (!row) {
        await recordAudit(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          action: 'agent_action.rejected',
          targetType: 'agent_conversation',
          targetId: conversationId,
          metadata: {
            tool: toolNameOf(part),
            approvalId: d.approvalId,
            issueKey: issueKeyOf(part.input),
            reason: 'superseded',
            recorded: false,
          },
        });
      }
      // Already decided: keep the recorded decision, only the stale part is closed.
      respond(part, d.approvalId, row ? row.status !== 'denied' : false, !row);
      parts.delete(d.approvalId);
      continue;
    }
    if (!row) throw new DecisionError('approval_not_found');
    if (row.status !== 'pending' || !part) throw new DecisionError('already_decided');
    if (
      hashInput(part.input ?? {}) !== row.inputHash ||
      part.toolCallId !== row.toolCallId ||
      toolNameOf(part) !== row.toolName
    ) {
      throw new DecisionError('approval_not_found');
    }
    await tx
      .update(agentApprovals)
      .set({ status: d.approved ? 'approved' : 'denied', decidedAt: new Date() })
      .where(eq(agentApprovals.id, row.id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: d.approved ? 'agent_action.approved' : 'agent_action.rejected',
      targetType: 'agent_conversation',
      targetId: conversationId,
      metadata: {
        tool: row.toolName,
        approvalId: row.approvalId,
        inputHash: row.inputHash,
        issueKey: issueKeyOf(row.input),
        ...(d.reason ? { reason: d.reason } : {}),
      },
    });
    respond(part, d.approvalId, d.approved, superseded);
    parts.delete(d.approvalId);
  }
  return messages;
}

export class ApprovalRequiredError extends Error {
  override name = 'ApprovalRequiredError';
  constructor() {
    super('This Jira change was not approved by the user.');
  }
}

/**
 * The last gate before a Jira write: atomically turns the user's approval of exactly this tool
 * call and input into an execution (approved → executed). Anything else throws, so a write can
 * never run without a recorded approval, and never twice.
 */
export async function claimApprovedExecution(
  db: Db,
  actor: AgentActor,
  call: { conversationId: string; toolCallId: string; toolName: string; input: unknown },
): Promise<{ approvalId: string; finish: (resultCode: string) => Promise<void> }> {
  const claimed = await withOrg(db, actor.orgId, (tx) =>
    tx
      .update(agentApprovals)
      .set({ status: 'executed', executedAt: new Date() })
      .where(
        and(
          eq(agentApprovals.orgId, actor.orgId),
          eq(agentApprovals.conversationId, call.conversationId),
          eq(agentApprovals.toolCallId, call.toolCallId),
          eq(agentApprovals.userId, actor.userId),
          eq(agentApprovals.toolName, call.toolName),
          eq(agentApprovals.status, 'approved'),
          eq(agentApprovals.inputHash, hashInput(call.input)),
        ),
      )
      .returning({ id: agentApprovals.id, approvalId: agentApprovals.approvalId }),
  );
  const row = claimed[0];
  if (!row) throw new ApprovalRequiredError();
  return {
    approvalId: row.approvalId,
    finish: (resultCode) =>
      withOrg(db, actor.orgId, async (tx) => {
        await tx
          .update(agentApprovals)
          .set({ resultCode, ...(resultCode === 'ok' ? {} : { status: 'failed' }) })
          .where(eq(agentApprovals.id, row.id));
        await recordAudit(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          action: resultCode === 'ok' ? 'agent_action.executed' : 'agent_action.failed',
          targetType: 'agent_conversation',
          targetId: call.conversationId,
          metadata: {
            tool: call.toolName,
            approvalId: row.approvalId,
            issueKey: issueKeyOf(call.input),
            result: resultCode,
          },
        });
      }),
  };
}
