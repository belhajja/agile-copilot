import { describe, expect, it } from 'vitest';
import { ApprovalRequiredError } from './approvals';
import { TOOL_ERROR_CODES, toolErrorCodeOf, toolErrorText } from './tool-errors';
import { AgentToolError } from './tools';
import { asUntrustedData } from './untrusted';

describe('tool error sentences', () => {
  it('reads the code back from every sentence it writes (Jira and analytics)', () => {
    for (const code of TOOL_ERROR_CODES) {
      for (const tool of ['jira', 'analytics'] as const) {
        const text = toolErrorText(code, tool);
        expect(toolErrorCodeOf(text)).toBe(code);
        // With data for the model after the sentence, too.
        expect(toolErrorCodeOf(`${text}\n${asUntrustedData('x', { a: 1 })}`)).toBe(code);
      }
    }
  });

  it('says plainly when an approved change was not sent, or may have been', () => {
    expect(toolErrorText('not_executed')).toBe(
      'The change was approved but not sent. Ask again to retry.',
    );
    expect(toolErrorText('unknown_outcome')).toBe(
      'The change may or may not have reached Jira. Check Jira before asking again.',
    );
    expect(toolErrorText('not_found')).toBe('The Jira request failed (not_found).');
    expect(toolErrorText('unknown_board', 'analytics')).toBe(
      'The analytics tool failed (unknown_board).',
    );
  });

  it('is what AgentToolError and ApprovalRequiredError say', () => {
    expect(new AgentToolError('not_executed').message).toBe(toolErrorText('not_executed'));
    expect(new AgentToolError('jira_error', { data: 'more' }).message).toBe(
      `${toolErrorText('jira_error')}\nmore`,
    );
    expect(toolErrorCodeOf(new ApprovalRequiredError().message)).toBe('approval_required');
  });

  it('knows no code for any other text', () => {
    for (const text of [undefined, '', 'Something broke', 'The Jira request failed (made_up).']) {
      expect(toolErrorCodeOf(text)).toBeUndefined();
    }
  });
});
