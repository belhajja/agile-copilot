import { REASON_TEXT } from '@agile/agent/reasons';
import type { ToolUIPart } from 'ai';
import { describe, expect, it } from 'vitest';
import { approvalView } from './approval-view';

const part = (p: Record<string, unknown>) =>
  ({ type: 'tool-jira_add_comment', toolCallId: 't1', input: {}, ...p }) as unknown as ToolUIPart;

describe('approvalView', () => {
  it('a waiting proposal in the latest message is actionable', () => {
    const v = approvalView(part({ state: 'approval-requested', approval: { id: 'a1' } }), true);
    expect(v).toEqual({
      state: 'approval-requested',
      approval: { id: 'a1' },
      closedBy: undefined,
      actionable: true,
    });
  });

  it('a waiting proposal in an older message is closed as superseded, without actions', () => {
    const v = approvalView(part({ state: 'approval-requested', approval: { id: 'a1' } }), false);
    expect(v).toEqual({
      state: 'output-denied',
      approval: { id: 'a1', approved: false },
      closedBy: 'superseded',
      actionable: false,
    });
  });

  it('reads the reason the server stored (superseded, forbidden_role) as a code', () => {
    for (const reason of ['superseded', 'forbidden_role'] as const) {
      const v = approvalView(
        part({
          state: 'output-denied',
          approval: { id: 'a1', approved: false, reason: REASON_TEXT[reason] },
        }),
        true,
      );
      expect(v.closedBy).toBe(reason);
      expect(v.actionable).toBe(false);
    }
  });

  it('a plain rejection has no reason', () => {
    const v = approvalView(
      part({ state: 'output-denied', approval: { id: 'a1', approved: false } }),
      false,
    );
    expect(v.closedBy).toBeUndefined();
  });
});
