/** The command was used wrongly or refused: exit code 2, the message says what to do. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** A step of a command failed: exit code 1. `detail` may hold Docker output (redact it). */
export class StepError extends Error {
  override name = 'StepError';
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step} failed`);
  }
}

/** One line for an error of any kind, keeping a StepError's step and detail. */
export function describeError(e: unknown): string {
  if (e instanceof StepError) {
    return e.detail ? `${e.step} failed: ${e.detail}` : `${e.step} failed`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
