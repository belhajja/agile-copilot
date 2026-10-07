import type { UIMessage } from 'ai';
import { toolErrorText } from './tool-errors';

/** A tool part as the AI SDK stores it in a message (only the fields read here). */
interface ToolPart {
  type: string;
  state?: string;
  input?: unknown;
  errorText?: string;
}

/** Called but never answered: the stream stopped (a malformed call, a provider error) mid-step. */
const UNANSWERED = new Set(['input-streaming', 'input-available']);

const unanswered = (part: ToolPart) =>
  (part.type.startsWith('tool-') || part.type === 'dynamic-tool') &&
  UNANSWERED.has(part.state ?? '');

/**
 * Closes the tool calls a failed reply left without a result: each gets the "not run" error. A
 * history with an unanswered call is refused by every model API, so without this one failed turn
 * would make every later message of the conversation fail too. Changes waiting for approval are
 * left alone. Returns the same array when there is nothing to close.
 */
export function closeUnansweredToolCalls(messages: UIMessage[]): UIMessage[] {
  const open = messages.some(
    (m) => m.role === 'assistant' && (m.parts as unknown as ToolPart[]).some(unanswered),
  );
  if (!open) return messages;
  return messages.map((m) =>
    m.role !== 'assistant'
      ? m
      : ({
          ...m,
          parts: (m.parts as unknown as ToolPart[]).map((p) =>
            unanswered(p)
              ? {
                  ...p,
                  state: 'output-error',
                  input: p.input ?? {},
                  errorText: toolErrorText('interrupted'),
                }
              : p,
          ),
        } as unknown as UIMessage),
  );
}
