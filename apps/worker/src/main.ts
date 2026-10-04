import { EnvError, parseWorkerEnv } from '@agile/config';
import { installCrashHandlers } from './crash';
import { log } from './log';
import { startWorker } from './worker';

let env: ReturnType<typeof parseWorkerEnv>;
try {
  env = parseWorkerEnv();
} catch (e) {
  // EnvError lists key names and rules only, never values.
  if (e instanceof EnvError) console.error(e.message);
  else log('error', 'worker_config_failed', { error: e instanceof Error ? e.name : 'unknown' });
  process.exit(1);
}

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
  // Backstop: pg-boss waits up to 30 s for running syncs; never hang beyond that.
  setTimeout(() => {
    log('error', 'worker_stop_timeout');
    process.exit(1);
  }, 45_000).unref();
  try {
    await worker.stop();
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
