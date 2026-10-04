import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncDeps } from './deps';
import { cronEvery, handleSyncJob, RetryableSyncError } from './queue';
import { runSync } from './run-sync';

vi.mock('./run-sync', () => ({ runSync: vi.fn() }));

const deps = {} as SyncDeps;
const job = { orgId: 'org_a', connectionId: 'c1', trigger: 'manual' };

describe('handleSyncJob', () => {
  beforeEach(() => vi.mocked(runSync).mockReset());

  it('drops a malformed payload without running or throwing, reporting only the error name', async () => {
    const onError = vi.fn();
    for (const bad of [null, {}, { ...job, orgId: '' }, { ...job, trigger: 'x' }, 'str']) {
      await expect(handleSyncJob(deps, bad, { onError })).resolves.toBeUndefined();
    }
    expect(runSync).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(5);
    expect(String(onError.mock.calls.flat()[0]?.name)).toBe('InvalidSyncJobError');
  });

  it.each(['rate_limited', 'unreachable'] as const)('throws for retryable %s', async (code) => {
    vi.mocked(runSync).mockResolvedValue({ ok: false, code });
    await expect(handleSyncJob(deps, job)).rejects.toBeInstanceOf(RetryableSyncError);
  });

  it.each(['unauthorized', 'jira_paging', 'already_running', 'not_found'] as const)(
    'completes normally for permanent %s',
    async (code) => {
      vi.mocked(runSync).mockResolvedValue({ ok: false, code });
      await expect(handleSyncJob(deps, job)).resolves.toEqual({ ok: false, code });
    },
  );

  it('rejects unsupported cron intervals', () => {
    for (const bad of [0, 7, 45, 90, -5, 1.5]) expect(() => cronEvery(bad)).toThrow();
    for (const good of [1, 5, 10, 15, 30, 60]) expect(() => cronEvery(good)).not.toThrow();
  });
});
