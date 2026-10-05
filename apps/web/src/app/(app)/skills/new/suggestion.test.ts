import { asUntrustedData } from '@agile/agent/untrusted';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { findSkillSuggestion } from './suggestion';

const DOC =
  '---\nname: weekly-velocity\ndescription: Velocity\ntrigger: on_demand\noutput: chat\n---\n\n1. Call list_boards.\n';
const output = (document: string) =>
  asUntrustedData('skill_suggestion', {
    name: 'weekly-velocity',
    description: 'Velocity',
    trigger: 'on_demand',
    output: 'chat',
    document,
  });

const toolPart = (over: Record<string, unknown>) =>
  ({
    type: 'tool-suggest_skill',
    toolCallId: 'call-1',
    state: 'output-available',
    input: {},
    output: output(DOC),
    ...over,
  }) as UIMessage['parts'][number];

const conversation = (...parts: UIMessage['parts']): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Save it as a skill' }] },
  { id: 'a1', role: 'assistant', parts },
];

describe('findSkillSuggestion', () => {
  it('returns the document of the matching suggest_skill result', () => {
    expect(findSkillSuggestion(conversation(toolPart({})), 'call-1')).toBe(DOC);
  });

  it('returns null for an unknown call id', () => {
    expect(findSkillSuggestion(conversation(toolPart({})), 'call-2')).toBeNull();
  });

  it('returns null when the call id belongs to another tool', () => {
    const part = toolPart({ type: 'tool-pin_widget', output: output(DOC) });
    expect(findSkillSuggestion(conversation(part), 'call-1')).toBeNull();
  });

  it('returns null while the result is unfinished or failed', () => {
    expect(
      findSkillSuggestion(
        conversation(toolPart({ state: 'input-available', output: undefined })),
        'call-1',
      ),
    ).toBeNull();
    expect(
      findSkillSuggestion(
        conversation(toolPart({ state: 'output-error', output: undefined, errorText: 'x' })),
        'call-1',
      ),
    ).toBeNull();
  });

  it('returns null when the stored document no longer parses', () => {
    const part = toolPart({ output: output('no frontmatter here') });
    expect(findSkillSuggestion(conversation(part), 'call-1')).toBeNull();
  });

  it('ignores a matching part in a user message', () => {
    const messages: UIMessage[] = [{ id: 'u1', role: 'user', parts: [toolPart({})] }];
    expect(findSkillSuggestion(messages, 'call-1')).toBeNull();
  });
});
