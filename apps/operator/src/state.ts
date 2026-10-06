import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mode } from './settings';

export interface HistoryEntry {
  from: string;
  to: string;
  at: string;
  result: 'ok' | 'rolled_back' | 'rollback_failed';
}

export interface InstallState {
  version: string;
  mode: Mode;
  installedAt: string;
  history: HistoryEntry[];
}

export function pathsOf(dataDir: string) {
  return {
    env: join(dataDir, '.env'),
    compose: join(dataDir, 'compose'),
    backups: join(dataDir, 'backups'),
    state: join(dataDir, 'operator.json'),
    lock: join(dataDir, '.operator.lock'),
  };
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export async function readState(dataDir: string): Promise<InstallState | null> {
  try {
    return JSON.parse(await readFile(pathsOf(dataDir).state, 'utf8')) as InstallState;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Written to a temporary file and renamed: a crash never leaves half a state file. */
export async function writeState(dataDir: string, state: InstallState): Promise<void> {
  const path = pathsOf(dataDir).state;
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/** For .env and backups: owner-only, also when the file already existed with other rights. */
export async function writeSecretFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

export class LockedError extends Error {
  override name = 'LockedError';
  constructor(path: string, since?: string) {
    super(
      `Another operator command is running on this folder (lock ${path}` +
        `${since ? `, held since ${since}` : ''}). Try again when it is done; if no operator ` +
        'command is running, delete it.',
    );
  }
}

/** A lock older than this was left by a run that was killed. */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export async function acquireLock(dataDir: string, now: Date): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const path = pathsOf(dataDir).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(JSON.stringify({ at: now.toISOString() }));
      await file.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as { at?: string };
      const age = now.getTime() - Date.parse(held.at ?? '');
      if (!(age > LOCK_STALE_MS)) throw new LockedError(path, held.at);
      await rm(path, { force: true });
    }
  }
  throw new LockedError(path);
}
