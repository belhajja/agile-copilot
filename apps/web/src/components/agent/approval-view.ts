import { type DecisionReason, decisionReasonOf } from '@agile/agent/reasons';
import type { ToolUIPart } from 'ai';

export interface ApprovalView {
  state: ToolUIPart['state'];
  approval: ToolUIPart['approval'];
  /** Why the proposal closed without the user's yes, when the server says so. */
  closedBy: DecisionReason | undefined;
  /** Approve / Reject are offered. */
  actionable: boolean;
}

/**
 * How an approval card shows a proposal. A proposal still waiting in an older message was closed
 * by the server when the user moved on (superseded): it is shown closed, never actionable.
 */
export function approvalView(part: ToolUIPart, inLatestMessage: boolean): ApprovalView {
  if (part.state === 'approval-requested' && !inLatestMessage) {
    return {
      state: 'output-denied',
      approval: part.approval ? { id: part.approval.id, approved: false } : undefined,
      closedBy: 'superseded',
      actionable: false,
    };
  }
  return {
    state: part.state,
    approval: part.approval,
    closedBy: decisionReasonOf(part.approval?.reason),
    actionable: part.state === 'approval-requested',
  };
}
