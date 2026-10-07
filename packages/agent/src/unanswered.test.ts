import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { toolErrorText } from './tool-errors';
import { closeUnansweredToolCalls } from './unanswered';

const reply = (parts: unknown[]): UIMessage =>
  ({ id: 'a1', role: 'assistant', parts }) as unknown as UIMessage;

describe('closeUnansweredToolCalls', () => {
  it('gives tool calls left without a result an error, so the history stays valid', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Sprint 77?' }] } as UIMessage,
      reply([
        { type: 'step-start' },
        {
          type: 'tool-query_board',
          toolCallId: 'c1',
          state: 'output-available',
          input: {},
          output: 'ok',
        },
        {
          type: 'tool-query_board',
          toolCallId: 'c2',
          state: 'input-available',
          input: { boardId: 'b' },
        },
        { type: 'tool-query_board', toolCallId: 'c3', state: 'input-streaming', input: undefined },
      ]),
    ];
    const closed = closeUnansweredToolCalls(messages);
    expect(closed[1]?.parts.slice(1)).toEqual([
      {
        type: 'tool-query_board',
        toolCallId: 'c1',
        state: 'output-available',
        input: {},
        output: 'ok',
      },
      {
        type: 'tool-query_board',
        toolCallId: 'c2',
        state: 'output-error',
        input: { boardId: 'b' },
        errorText: toolErrorText('interrupted'),
      },
      {
        type: 'tool-query_board',
        toolCallId: 'c3',
        state: 'output-error',
        input: {},
        errorText: toolErrorText('interrupted'),
      },
    ]);
    // The input is not changed in place: the caller may still hold it.
    expect(messages[1]?.parts[2]).toMatchObject({ state: 'input-available' });
  });

  it('leaves answered histories and changes waiting for approval as they are', () => {
    const messages = [
      reply([
        {
          type: 'tool-jira_add_comment',
          toolCallId: 'c1',
          state: 'approval-requested',
          input: {},
          approval: { id: 'x' },
        },
        {
          type: 'tool-list_boards',
          toolCallId: 'c2',
          state: 'output-error',
          input: {},
          errorText: 'failed',
        },
      ]),
    ];
    expect(closeUnansweredToolCalls(messages)).toBe(messages);
  });
});
