import { z } from 'zod';
import { EnvError, parseServerEnv, type ServerEnv } from './env';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/** Intervals `cronEvery` (@agile/sync) can express as a regular cron schedule. */
const SYNC_INTERVALS = [5, 10, 15, 30, 60];

const workerExtrasSchema = z.object({
  /** Minutes between scheduled syncs. */
  SYNC_INTERVAL_MINUTES: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int()
      .refine((n) => SYNC_INTERVALS.includes(n), 'must be 5, 10, 15, 30 or 60')
      .default(15),
  ),
  /** Port of the worker's /health endpoint. 0 picks a free port (tests). */
  WORKER_HEALTH_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(65_535).default(8080),
  ),
  /** Interface /health listens on. Loopback unless a container image opts in to 0.0.0.0. */
  WORKER_HEALTH_HOST: z.preprocess(emptyToUndefined, z.string().min(1).default('127.0.0.1')),
});

export type WorkerEnv = ServerEnv & z.infer<typeof workerExtrasSchema>;

/** The server environment (same .env as the web app) plus the worker's own settings. */
export function parseWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  const server = parseServerEnv(source);
  const extras = workerExtrasSchema.safeParse(source);
  if (!extras.success) {
    // Key names and rule text only: zod issues for these keys never carry the input value.
    const lines = extras.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`Invalid worker environment:\n${lines.join('\n')}`);
  }
  return { ...server, ...extras.data };
}
