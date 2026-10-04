/** Longest the exit waits for the flush: well inside the 30 s grace period (Helm, compose). */
export const FLUSH_TIMEOUT_MS = 10_000;

interface ExitingProcess {
  once(event: 'SIGTERM', listener: () => void): unknown;
  exit(code?: number): void;
}

/**
 * Runs `flush` (the Langfuse trace export) on SIGTERM and holds the process exit until it has
 * finished, at most `timeoutMs`. Next.js handles SIGTERM itself: it stops accepting requests, lets
 * running ones finish, then calls `process.exit`, which would cut a flush still in flight; so
 * after SIGTERM that exit waits for the flush. A failing flush never blocks shutdown.
 */
export function flushOnSigterm(
  flush: () => Promise<void>,
  { proc = process as ExitingProcess, timeoutMs = FLUSH_TIMEOUT_MS } = {},
): void {
  proc.once('SIGTERM', () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushed = Promise.race([
      flush().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    const exit = proc.exit.bind(proc);
    proc.exit = (code?: number) => {
      void flushed.then(() => exit(code));
    };
  });
}
