import { describe, expect, it } from 'vitest';
import { JiraHttpError } from './no-redirect-client';
import { errorRetryAfterMs, errorStatus, withRateLimitRetry } from './rate-limit';

const sleeps = () => {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
};

describe('withRateLimitRetry', () => {
  it('waits for Retry-After, then succeeds', async () => {
    const { waited, sleep } = sleeps();
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls++;
        if (calls < 3) throw new JiraHttpError(429, 2_000);
        return 'ok';
      },
      { sleep },
    );
    expect(result).toBe('ok');
    expect(waited).toEqual([2_000, 2_000]);
  });

  it('backs off exponentially without Retry-After and caps long waits', async () => {
    const { waited, sleep } = sleeps();
    await expect(
      withRateLimitRetry(
        async () => {
          throw new JiraHttpError(503);
        },
        { sleep, maxRetries: 3 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(waited).toEqual([1_000, 2_000, 4_000]);

    const capped = sleeps();
    await expect(
      withRateLimitRetry(
        async () => {
          throw new JiraHttpError(429, 3_600_000);
        },
        { sleep: capped.sleep, maxRetries: 1, maxWaitMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(JiraHttpError);
    expect(capped.waited).toEqual([60_000]);
  });

  it('stops waiting the moment the signal aborts, and never calls again once aborted', async () => {
    const ac = new AbortController();
    let calls = 0;
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw new JiraHttpError(429, 60_000);
        },
        { signal: ac.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(1);
    await expect(
      withRateLimitRetry(async () => 'never', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not retry other failures', async () => {
    const { waited, sleep } = sleeps();
    await expect(
      withRateLimitRetry(
        async () => {
          throw new JiraHttpError(401);
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(waited).toEqual([]);
  });

  it('reads status and Retry-After from jira.js v5 (axios) errors', () => {
    const v5 = { status: 429, cause: { response: { headers: { 'retry-after': '4' } } } };
    expect(errorStatus(v5)).toBe(429);
    expect(errorRetryAfterMs(v5)).toBe(4_000);
    expect(errorStatus(new Error('x'))).toBeUndefined();
  });
});
