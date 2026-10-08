import { isToolUIPart, type UIMessage } from 'ai';
import { toolErrorText } from './tool-errors';
import { assistantToolParts, type ToolPart } from './tool-parts';

/** Called but never answered: the stream stopped (a malformed call, a provider error) mid-step. */
const unanswered = (part: ToolPart) =>
  part.state === 'input-streaming' || part.state === 'input-available';

/**
 * Closes the tool calls a failed reply left without a result: each gets the "not run" error. A
 * history with an unanswered call is refused by every model API, so without this one failed turn
 * would make every later message of the conversation fail too. Changes waiting for approval are
 * left alone. Returns the same array when there is nothing to close.
 */
export function closeUnansweredToolCalls(messages: UIMessage[]): UIMessage[] {
  if (!assistantToolParts(messages).some(unanswered)) return messages;
  return messages.map((m) =>
    m.role !== 'assistant'
      ? m
      : {
          ...m,
          parts: m.parts.map((p) =>
            isToolUIPart(p) && unanswered(p)
              ? {
                  ...p,
                  state: 'output-error' as const,
                  input: p.input ?? {},
                  errorText: toolErrorText('interrupted'),
                }
              : p,
          ),
        },
  );
}
