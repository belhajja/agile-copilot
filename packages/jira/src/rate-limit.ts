import { parseRetryAfter } from './no-redirect-client';

export interface RetryOptions {
  /** Retries after the first attempt (default 5). */
  maxRetries?: number;
  /** Longest single wait (default 60 s); a longer Retry-After is capped. */
  maxWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 503]);

const field = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;

/** HTTP status of a v6 (JiraHttpError) or v5 (HttpException / axios) error. */
export function errorStatus(e: unknown): number | undefined {
  const status = field(e, 'status') ?? field(field(e, 'response'), 'status');
  return typeof status === 'number' ? status : undefined;
}

/** Retry-After in ms: set directly by our v6 client, or read from the axios response headers (v5). */
export function errorRetryAfterMs(e: unknown): number | undefined {
  const direct = field(e, 'retryAfterMs');
  if (typeof direct === 'number') return direct;
  const headers =
    field(field(field(e, 'cause'), 'response'), 'headers') ??
    field(field(e, 'response'), 'headers');
  const value = field(headers, 'retry-after');
  return typeof value === 'string' ? parseRetryAfter(value) : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying on 429/503: waits for Retry-After when Jira sends it (Jira Cloud does on
 * 429), otherwise 1 s, 2 s, 4 s… Gives up after `maxRetries` and rethrows the last error.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const maxWait = opts.maxWaitMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = errorStatus(e);
      if (status === undefined || !RETRYABLE.has(status) || attempt >= maxRetries) throw e;
      await sleep(Math.min(errorRetryAfterMs(e) ?? 1000 * 2 ** attempt, maxWait));
    }
  }
}
