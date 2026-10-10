import { getToolName, isToolUIPart, type UIMessage } from 'ai';

/** What the assistant is doing right now, shown under the reply while it runs. */
export type Activity =
  | { kind: 'thinking' }
  | { kind: 'reasoning' }
  | { kind: 'tool'; name: string }
  | { kind: 'writing' };

/**
 * The activity of a running reply, from the last part of the last message: the request is sent
 * (`submitted`), the model is reasoning or writing, or a tool runs. Null when nothing runs.
 */
export function activityOf(
  messages: readonly UIMessage[],
  status: 'submitted' | 'streaming' | 'ready' | 'error',
): Activity | null {
  if (status === 'submitted') return { kind: 'thinking' };
  if (status !== 'streaming') return null;
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return { kind: 'thinking' };
  const part = last.parts.at(-1);
  if (!part) return { kind: 'thinking' };
  if (part.type === 'reasoning')
    return part.state === 'done' ? { kind: 'thinking' } : { kind: 'reasoning' };
  if (part.type === 'text')
    return part.state === 'done' ? { kind: 'thinking' } : { kind: 'writing' };
  if (
    isToolUIPart(part) &&
    (part.state === 'input-streaming' || part.state === 'input-available')
  ) {
    return { kind: 'tool', name: getToolName(part) };
  }
  // A step just started, or a tool returned: the model is working on its next step.
  return { kind: 'thinking' };
}
