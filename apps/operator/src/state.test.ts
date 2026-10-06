import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireLock,
  LOCK_STALE_MS,
  LockedError,
  pathsOf,
  readState,
  writeSecretFile,
  writeState,
} from './state';

const dir = () => mkdtemp(join(tmpdir(), 'operator-state-'));

describe('state folder', () => {
  it('reads nothing before an install, then what was written', async () => {
    const d = await dir();
    expect(await readState(d)).toBeNull();
    const state = { version: 'v1.0.0', mode: 'local' as const, installedAt: 'now', history: [] };
    await writeState(d, state);
    expect(await readState(d)).toEqual(state);
  });

  it('refuses a second run and takes over a stale lock', async () => {
    const d = await dir();
    const now = new Date('2026-10-06T12:00:00Z');
    const release = await acquireLock(d, now);
    await expect(acquireLock(d, now)).rejects.toBeInstanceOf(LockedError);
    const message = await acquireLock(d, new Date(now.getTime() + 60_000)).catch(
      (e: Error) => e.message,
    );
    expect(message).toContain(pathsOf(d).lock);
    expect(message).toContain('held since 2026-10-06T12:00:00.000Z');
    expect(message).toMatch(/delete it/);
    await release();
    await acquireLock(d, now);
    // A lock a killed run left behind, older than LOCK_STALE_MS.
    const later = new Date(now.getTime() + LOCK_STALE_MS + 1);
    const again = await acquireLock(d, later);
    await again();
  });

  it('writes secret files readable by the owner only', async () => {
    const d = await dir();
    const path = pathsOf(d).env;
    await writeFile(path, 'old', { mode: 0o644 });
    await writeSecretFile(path, 'A=1\n');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
