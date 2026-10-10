import { DEFAULT_MAX_OUTPUT_TOKENS } from '@agile/llm/output-budget';
import type { StopCondition, ToolSet } from 'ai';
import { FOLLOWUPS_TOOL } from './followups';

/** Model steps per chat reply (tool round-trips included). */
export const CHAT_MAX_STEPS = 12;

/**
 * Output tokens per model call of a chat reply: the model's own budget, else the default.
 * Reasoning models spend part of it thinking before they write: a matrix or a long table can take
 * several thousand tokens of reasoning alone.
 */
export const chatOutputTokens = (maxOutputTokens: number | null) =>
  maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

/** The slowest output a reply's deadline is sized for (a local reasoning model writes ~80/s). */
const DEADLINE_TOKENS_PER_SECOND = 60;
const MIN_REPLY_DEADLINE_MS = 5 * 60_000;
const MAX_REPLY_DEADLINE_MS = 15 * 60_000;

/**
 * A chat reply's deadline: the time to write its whole output budget at 60 tokens a second,
 * between 5 and 15 minutes.
 */
export function replyDeadlineMs(maxOutputTokens: number): number {
  const ms = Math.ceil((maxOutputTokens / DEADLINE_TOKENS_PER_SECOND) * 1_000);
  return Math.min(MAX_REPLY_DEADLINE_MS, Math.max(MIN_REPLY_DEADLINE_MS, ms));
}

/**
 * How long a turn holds its conversation: twice its reply's deadline, so the reply always ends
 * (and is stored) before another turn can take the conversation over.
 */
export const turnLeaseSeconds = (deadlineMs: number) => Math.ceil((deadlineMs * 2) / 1_000);

/**
 * `prepareStep` for a step-limited reply: the last allowed step offers no tools, so the model
 * has to answer with what it gathered instead of stopping on a tool call with nothing said.
 */
export function lastStepWithoutTools(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber >= maxSteps - 1 ? { activeTools: [], toolChoice: 'none' as const } : undefined;
}

/** Added to the system prompt for the last step of a chat reply. */
export const LAST_STEP_INSTRUCTIONS = `This is your last step: no more data can be gathered. Answer now
with what you have, say what is still missing, and offer the rest with suggest_followups.`;

/**
 * `prepareStep` for a chat reply: like `lastStepWithoutTools`, except that the last step still
 * offers `suggest_followups` and is told it is the last, so a reply cut short by its step limit
 * ends with an answer and the way to get the rest.
 */
export function lastStepWithFollowups(maxSteps: number) {
  return ({ stepNumber, instructions }: { stepNumber: number; instructions?: unknown }) =>
    stepNumber >= maxSteps - 1
      ? {
          activeTools: [FOLLOWUPS_TOOL],
          toolChoice: 'auto' as const,
          instructions:
            typeof instructions === 'string'
              ? `${instructions}\n\n${LAST_STEP_INSTRUCTIONS}`
              : LAST_STEP_INSTRUCTIONS,
        }
      : undefined;
}

/**
 * Ends a chat reply once it offered its follow-ups: the last step only called
 * `suggest_followups`, and the reply has said something.
 */
export const followupsOffered: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  if (!last || last.toolCalls.length === 0) return false;
  return (
    last.toolCalls.every((c) => c.toolName === FOLLOWUPS_TOOL) &&
    steps.some((s) => s.text.trim() !== '')
  );
};

/**
 * The bounds of one model run (chat reply, skill run, skill draft), spread into `streamText` or
 * `generateText`: output tokens per call, a deadline for the whole run (combined with `signal`)
 * and no automatic retry, so a failed call fails the run instead of being paid for again.
 */
export function llmCallLimits(opts: {
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  return {
    maxOutputTokens: opts.maxOutputTokens,
    maxRetries: 0,
    abortSignal: opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline,
  };
}

/** Whether a run was stopped by its deadline (not cancelled). */
export const timedOut = (signal: AbortSignal) =>
  signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
