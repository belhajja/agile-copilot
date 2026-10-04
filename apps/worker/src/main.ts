import { EnvError, langfuseConfigOf, parseWorkerEnv } from '@agile/config';
import { startTracing } from '@agile/observability';
import { installCrashHandlers } from './crash';
import { log } from './log';
import { startWorker, WORKER_STOP_BACKSTOP_MS } from './worker';

let env: ReturnType<typeof parseWorkerEnv>;
try {
  env = parseWorkerEnv();
} catch (e) {
  // EnvError lists key names and rules only, never values.
  if (e instanceof EnvError) console.error(e.message);
  else log('error', 'worker_config_failed', { error: e instanceof Error ? e.name : 'unknown' });
  process.exit(1);
}

// Optional LLM tracing (skill runs): off unless LANGFUSE_* is set; redacted before export.
const langfuse = langfuseConfigOf(env);
const tracing = langfuse ? startTracing(langfuse) : null;

let worker: Awaited<ReturnType<typeof startWorker>>;
try {
  worker = await startWorker(env, log);
} catch (e) {
  log('error', 'worker_start_failed', { error: e instanceof Error ? e.name : 'unknown' });
  process.exit(1);
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  const crashed = signal === 'unhandledRejection' || signal === 'uncaughtException';
  log('info', 'worker_stopping', { signal });
  // Backstop: pg-boss waits up to WORKER_STOP_TIMEOUT_MS for running jobs; never hang beyond that.
  setTimeout(() => {
    log('error', 'worker_stop_timeout');
    process.exit(1);
  }, WORKER_STOP_BACKSTOP_MS).unref();
  try {
    await worker.stop();
    await tracing?.shutdown().catch(() => undefined);
    log('info', 'worker_stopped');
    process.exit(crashed ? 1 : 0);
  } catch (e) {
    log('error', 'worker_stop_failed', { error: e instanceof Error ? e.name : 'unknown' });
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
installCrashHandlers(process, log, (reason) => void shutdown(reason));
