import { createHash } from 'node:crypto';
import { recordAudit } from '@agile/connections';
import { agentApprovals, type Db, type Tx, withOrg } from '@agile/db';
import type { JiraToolErrorCode } from '@agile/jira-tools';
import { ISSUE_KEY_PATTERN } from '@agile/jira-tools/catalog';
import { getToolName, type ToolUIPart, type UIMessage } from 'ai';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireOwnConversation } from './conversations';
import type { AgentActor } from './deps';
import { type DecisionReason, REASON_TEXT } from './reasons';
import { type CredentialErrorCode, toolErrorText } from './tool-errors';
import { jiraWriteParts } from './tool-parts';
import { asUntrustedData } from './untrusted';

export type { DecisionReason };

/**
 * Canonical JSON (sorted keys) → sha256. Binds an approval to the exact tool input. An absent
 * input counts as `{}`, the same at proposal, decision and claim time.
 */
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
    .update(JSON.stringify(canonical(input ?? {})))
    .digest('hex');
}

/** Tool parts of Jira writes waiting for the user (in the order the model proposed them). */
export function pendingApprovalParts(messages: UIMessage[]): ToolUIPart[] {
  return jiraWriteParts(
    messages,
    (p) => p.state === 'approval-requested' && typeof p.approval?.id === 'string',
  );
}

/** The issue key for the audit trail, only when it looks like one (model input is untrusted). */
const issueKeyOf = (input: unknown) => {
  const key = (input as { issueKey?: unknown } | null)?.issueKey;
  return typeof key === 'string' && ISSUE_KEY_PATTERN.test(key) ? key : null;
};

/** Closes a proposal in the stored messages (the AI SDK then runs or skips the tool call). */
function respond(
  part: ToolUIPart,
  approvalId: string,
  approved: boolean,
  reason: DecisionReason | undefined,
) {
  Object.assign(part, {
    state: 'approval-responded',
    approval: {
      ...part.approval,
      id: approvalId,
      approved,
      ...(reason ? { reason: REASON_TEXT[reason] } : {}),
    },
  });
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
    const toolName = getToolName(part);
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
        inputHash: hashInput(part.input),
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
 * `reason: 'superseded'` closes proposals the user moved past, always as not approved: a pending
 * row is denied; a row already decided is left as it is (even 'approved': it is never claimed,
 * since the part no longer asks the SDK to run it); a proposal that never got a row (its stream
 * was not stored) is audited as rejected, `recorded: false`. `reason: 'forbidden_role'` denies a
 * proposal its user may no longer approve (demoted since it was made).
 */
export async function applyDecisions(
  tx: Tx,
  actor: AgentActor,
  conversationId: string,
  messages: UIMessage[],
  decisions: { approvalId: string; approved: boolean; reason?: DecisionReason }[],
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
      // Approved but never run: closed for good, so no row stays armed (M1).
      if (row?.status === 'approved') {
        await failApprovedRow(tx, actor, row, 'not_executed', { reason: 'superseded' });
      }
      if (!row) {
        await recordAudit(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          action: 'agent_action.rejected',
          targetType: 'agent_conversation',
          targetId: conversationId,
          metadata: {
            tool: getToolName(part),
            approvalId: d.approvalId,
            issueKey: issueKeyOf(part.input),
            reason: 'superseded',
            recorded: false,
          },
        });
      }
      // Already decided: the row keeps the recorded decision, but the stale part is closed as
      // NOT approved (P3-R18) so the SDK never runs an approved-but-unexecuted change later.
      respond(part, d.approvalId, false, 'superseded');
      parts.delete(d.approvalId);
      continue;
    }
    if (!row) throw new DecisionError('approval_not_found');
    if (row.status !== 'pending' || !part) throw new DecisionError('already_decided');
    if (
      hashInput(part.input) !== row.inputHash ||
      part.toolCallId !== row.toolCallId ||
      getToolName(part) !== row.toolName
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
    respond(part, d.approvalId, d.approved, d.reason);
    parts.delete(d.approvalId);
  }
  return messages;
}

/**
 * Outcome stored for an approved Jira write: 'ok', the failure code the tool reported, or why it
 * never ran (`not_executed`, `forbidden_role`).
 */
export type ExecutionResultCode =
  | 'ok'
  | JiraToolErrorCode
  | CredentialErrorCode
  | 'not_executed'
  | 'forbidden_role';

export class ApprovalRequiredError extends Error {
  override name = 'ApprovalRequiredError';
  readonly code = 'approval_required';
  constructor() {
    super(toolErrorText('approval_required'));
  }
}

type ApprovalRow = typeof agentApprovals.$inferSelect;

/** Closes an approved row that will never run as failed with `code` (audited); false if not approved. */
async function failApprovedRow(
  tx: Tx,
  actor: AgentActor,
  row: Pick<ApprovalRow, 'id' | 'conversationId' | 'approvalId' | 'toolName' | 'input'>,
  code: Exclude<ExecutionResultCode, 'ok'>,
  extra: { reason?: DecisionReason } = {},
): Promise<boolean> {
  const updated = await tx
    .update(agentApprovals)
    .set({ status: 'failed', resultCode: code })
    .where(and(eq(agentApprovals.id, row.id), eq(agentApprovals.status, 'approved')))
    .returning({ id: agentApprovals.id });
  if (updated.length === 0) return false;
  await recordAudit(tx, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: 'agent_action.failed',
    targetType: 'agent_conversation',
    targetId: row.conversationId,
    metadata: {
      tool: row.toolName,
      approvalId: row.approvalId,
      issueKey: issueKeyOf(row.input),
      result: code,
      ...extra,
    },
  });
  return true;
}

type ExecutionCall = {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** The approved row of exactly this call: user, conversation, tool call, tool and input hash. */
const approvedRowOf = (actor: AgentActor, call: ExecutionCall) =>
  and(
    eq(agentApprovals.orgId, actor.orgId),
    eq(agentApprovals.conversationId, call.conversationId),
    eq(agentApprovals.toolCallId, call.toolCallId),
    eq(agentApprovals.userId, actor.userId),
    eq(agentApprovals.toolName, call.toolName),
    eq(agentApprovals.status, 'approved'),
    eq(agentApprovals.inputHash, hashInput(call.input)),
  );

/**
 * The last gate before a Jira write: atomically turns the user's approval of exactly this tool
 * call and input into an execution (approved → executed). Anything else throws, so a write can
 * never run without a recorded approval, and never twice. One call claims one row, even when a
 * provider reused the tool call id for an identical proposal.
 */
export async function claimApprovedExecution(
  db: Db,
  actor: AgentActor,
  call: ExecutionCall,
): Promise<{ approvalId: string; finish: (resultCode: ExecutionResultCode) => Promise<void> }> {
  const claimed = await withOrg(db, actor.orgId, (tx) =>
    tx
      .update(agentApprovals)
      .set({ status: 'executed', executedAt: new Date() })
      .where(
        and(
          approvedRowOf(actor, call),
          eq(
            agentApprovals.id,
            sql`(select ${agentApprovals.id} from ${agentApprovals} where ${approvedRowOf(actor, call)} order by ${agentApprovals.createdAt} limit 1 for update skip locked)`,
          ),
        ),
      )
      .returning({ id: agentApprovals.id, approvalId: agentApprovals.approvalId }),
  );
  const row = claimed[0];
  if (!row) throw new ApprovalRequiredError();
  return {
    approvalId: row.approvalId,
    // Idempotent: only the first outcome is stored and audited.
    finish: (resultCode) =>
      withOrg(db, actor.orgId, async (tx) => {
        const updated = await tx
          .update(agentApprovals)
          .set({ resultCode, ...(resultCode === 'ok' ? {} : { status: 'failed' as const }) })
          .where(and(eq(agentApprovals.id, row.id), isNull(agentApprovals.resultCode)))
          .returning({ id: agentApprovals.id });
        if (updated.length === 0) return;
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

/**
 * A write refused before its claim (role, site): closes its approved row as failed with `code`
 * and audits it, so no approval stays armed. Nothing happens without a matching approved row.
 */
export async function refuseApprovedExecution(
  db: Db,
  actor: AgentActor,
  call: ExecutionCall,
  code: Exclude<ExecutionResultCode, 'ok'>,
): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(agentApprovals)
      .where(approvedRowOf(actor, call))
      .for('update');
    for (const row of rows) await failApprovedRow(tx, actor, row, code);
  });
}

/** What the model is told when a change ran but its result could not be shown or stored. */
export const WRITE_DONE_UNREADABLE = 'The change was made in Jira; its result could not be shown.';

/**
 * Gives every approved Jira change in `messages` a result, inside the caller's transaction (P3-R26).
 * A turn can fail after the user's approval is stored and before (or after) the change ran: the
 * stored part then has no output, and the next model request would carry a tool call without a
 * result, which most providers reject. For each approved write part without a result, from the row:
 * - still `approved` (never ran): closed as failed/`not_executed` (audited), with the fixed
 *   "approved but not sent" sentence as the part's error;
 * - claimed with an outcome: `ok` → the "change was made" note, a failure → its sentence;
 * - claimed without an outcome (it may have reached Jira): the "unknown outcome" sentence.
 * A part the tool already answered keeps its result; only a row left `approved` is closed.
 */
export async function settleApprovedParts(
  tx: Tx,
  actor: AgentActor,
  conversationId: string,
  messages: UIMessage[],
): Promise<UIMessage[]> {
  const parts = jiraWriteParts(
    messages,
    (p) =>
      p.approval?.approved === true &&
      typeof p.approval.id === 'string' &&
      (p.state === 'approval-responded' || p.state === 'output-error'),
  );
  if (parts.length === 0) return messages;
  await requireOwnConversation(tx, actor, conversationId);
  for (const part of parts) {
    const [row] = await tx
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.conversationId, conversationId),
          eq(agentApprovals.approvalId, part.approval?.id ?? ''),
          eq(agentApprovals.userId, actor.userId),
        ),
      )
      .for('update');
    const neverRan = !row || row.status === 'approved' || row.status === 'pending';
    if (row?.status === 'approved') await failApprovedRow(tx, actor, row, 'not_executed');
    if (part.state === 'output-error') {
      // The tool (or the SDK) already answered; only a change that never ran gets the sentence.
      if (neverRan) part.errorText = toolErrorText('not_executed');
      continue;
    }
    if (neverRan || row.status === 'denied') {
      setError(part, toolErrorText('not_executed'));
    } else if (row.resultCode === 'ok') {
      Object.assign(part, {
        state: 'output-available',
        output: asUntrustedData(getToolName(part), { ok: true, note: WRITE_DONE_UNREADABLE }),
      });
    } else if (row.resultCode) {
      setError(part, toolErrorText(row.resultCode as Exclude<ExecutionResultCode, 'ok'>));
    } else {
      setError(part, toolErrorText('unknown_outcome'));
    }
  }
  return messages;
}

function setError(part: ToolUIPart, errorText: string) {
  Object.assign(part, { state: 'output-error', errorText });
}
