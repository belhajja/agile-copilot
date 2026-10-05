import { describe, expect, it } from 'vitest';
import { ApprovalRequiredError } from './approvals';
import { AgentToolError, TOOL_ERROR_CODES, toolErrorCodeOf, toolErrorText } from './tool-errors';
import { asUntrustedData } from './untrusted';

describe('tool error sentences', () => {
  it('reads the code back from every sentence it writes (every tool kind)', () => {
    for (const code of TOOL_ERROR_CODES) {
      for (const tool of ['jira', 'analytics', 'skill', 'dashboard'] as const) {
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

  it('names load_skill and pin_widget failures for what they are (P4-R13)', () => {
    expect(toolErrorText('unknown_skill', 'skill')).toBe(
      'The skill could not be loaded (unknown_skill).',
    );
    expect(toolErrorText('invalid_widget', 'dashboard')).toBe(
      'The chart could not be pinned (invalid_widget).',
    );
    expect(toolErrorText('dashboard_full', 'dashboard')).toBe(
      'The chart could not be pinned (dashboard_full).',
    );
    expect(toolErrorText('dashboard_unavailable', 'dashboard')).toBe(
      'The chart could not be pinned (dashboard_unavailable).',
    );
    expect(toolErrorText('skill_suggestion_invalid', 'suggestion')).toBe(
      'The skill could not be drafted (skill_suggestion_invalid).',
    );
    expect(TOOL_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'unknown_skill',
        'invalid_widget',
        'dashboard_full',
        'dashboard_unavailable',
        'skill_suggestion_invalid',
      ]),
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
