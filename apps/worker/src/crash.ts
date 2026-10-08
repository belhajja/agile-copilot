import { errorName, type Logger } from '@agile/observability/log';

interface ProcessEvents {
  on(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (error: unknown) => void,
  ): unknown;
}

/**
 * A stray rejection or exception must not leave the worker half-alive (or die without releasing
 * its sync leases): log the error NAME only (messages may carry tokens or URLs) and shut down
 * gracefully, which aborts running syncs.
 */
export function installCrashHandlers(
  proc: ProcessEvents,
  log: Logger,
  shutdown: (reason: string) => void,
): void {
  proc.on('unhandledRejection', (error) => {
    log('error', 'unhandled_rejection', { error: errorName(error) });
    shutdown('unhandledRejection');
  });
  proc.on('uncaughtException', (error) => {
    log('error', 'uncaught_exception', { error: errorName(error) });
    shutdown('uncaughtException');
  });
}
