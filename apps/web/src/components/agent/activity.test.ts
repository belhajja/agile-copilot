import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { activityOf } from './activity';

const user: UIMessage = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hi' }] };
const reply = (parts: UIMessage['parts']): UIMessage[] => [
  user,
  { id: 'a', role: 'assistant', parts },
];

describe('activityOf', () => {
  it('is nothing once the reply has ended', () => {
    expect(activityOf(reply([{ type: 'text', text: 'Done', state: 'done' }]), 'ready')).toBeNull();
    expect(activityOf([user], 'error')).toBeNull();
  });

  it('is thinking while the request is sent and before anything arrives', () => {
    expect(activityOf([user], 'submitted')).toEqual({ kind: 'thinking' });
    expect(activityOf([user], 'streaming')).toEqual({ kind: 'thinking' });
    expect(activityOf(reply([{ type: 'step-start' }]), 'streaming')).toEqual({ kind: 'thinking' });
  });

  it('follows the last part: reasoning, a running tool, then writing', () => {
    expect(
      activityOf(reply([{ type: 'reasoning', text: 'Let me…', state: 'streaming' }]), 'streaming'),
    ).toEqual({ kind: 'reasoning' });
    expect(
      activityOf(
        reply([
          {
            type: 'tool-get_metric',
            toolCallId: 'c1',
            state: 'input-available',
            input: { metric: 'velocity' },
          },
        ]),
        'streaming',
      ),
    ).toEqual({ kind: 'tool', name: 'get_metric' });
    expect(
      activityOf(reply([{ type: 'text', text: 'The velocity', state: 'streaming' }]), 'streaming'),
    ).toEqual({ kind: 'writing' });
  });

  it('is thinking between steps: a tool returned, or reasoning ended', () => {
    expect(
      activityOf(
        reply([
          {
            type: 'tool-get_metric',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: {},
          },
        ]),
        'streaming',
      ),
    ).toEqual({ kind: 'thinking' });
    expect(
      activityOf(reply([{ type: 'reasoning', text: 'Done.', state: 'done' }]), 'streaming'),
    ).toEqual({ kind: 'thinking' });
  });
});
