import { TURN_LEASE_SECONDS } from './conversations';

/** Model steps per chat reply (tool round-trips included). */
export const CHAT_MAX_STEPS = 12;
/**
 * Output tokens per model call of a chat reply. Reasoning models spend part of it thinking before
 * they write: a matrix or a long table can take several thousand tokens of reasoning alone.
 */
export const CHAT_MAX_OUTPUT_TOKENS = 16_000;
/** A chat reply's deadline: half its lease, so it always ends before another turn can take over. */
export const CHAT_TURN_TIMEOUT_MS = (TURN_LEASE_SECONDS * 1_000) / 2;

/**
 * `prepareStep` for a step-limited reply: the last allowed step offers no tools, so the model
 * has to answer with what it gathered instead of stopping on a tool call with nothing said.
 */
export function lastStepWithoutTools(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber >= maxSteps - 1 ? { activeTools: [], toolChoice: 'none' as const } : undefined;
}

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
