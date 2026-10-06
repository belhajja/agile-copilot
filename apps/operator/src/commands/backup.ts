import { randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../context';
import { Compose, waitHealthy, waitService } from '../docker';
import { UsageError } from '../errors';
import { acquireLock, type InstallState, pathsOf, readState, writeState } from '../state';

export const KEEP_BACKUPS = 10;

const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T/;

/** Backup folder names, oldest first: complete backups only (no `.partial`, no stray entries). */
export async function listBackups(backupsDir: string): Promise<string[]> {
  try {
    return (await readdir(backupsDir))
      .filter((name) => BACKUP_NAME.test(name) && !name.endsWith('.partial'))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

async function isCompleteBackup(dir: string): Promise<boolean> {
  for (const entry of ['db.dump', '.env', 'compose', 'version']) {
    if (!(await stat(join(dir, entry)).catch(() => null))) return false;
  }
  return true;
}

/**
 * The database (pg_dump custom format) with the .env and compose files of the same moment: the
 * .env holds ENCRYPTION_KEYS, without which the stored Jira and AI credentials cannot be read.
 *
 * Written to a `.partial` folder and renamed to its final name only once everything is there, so
 * a failed or interrupted dump never leaves something `restore latest` could pick up; on failure
 * the `.partial` folder is removed. `prune: false` skips trimming to KEEP_BACKUPS, for a safety
 * backup taken mid-restore that must not be the one pruned away.
 */
export async function takeBackup(
  ctx: Context,
  state: InstallState,
  compose: Compose,
  o: { prune?: boolean } = {},
): Promise<string> {
  const p = pathsOf(ctx.dataDir);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  // The random suffix keeps two backups apart even when taken within the same clock tick, as a
  // restore's safety backup can be: the folder name must never collide with an existing one.
  const name = `${stamp}-${state.version.replace(/[^\w.-]/g, '_')}-${randomBytes(3).toString('hex')}`;
  const dir = join(p.backups, name);
  const partial = `${dir}.partial`;
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    await compose.check(
      'backup',
      ['exec', '-T', 'postgres', 'pg_dump', '-U', 'agile', '-d', 'agile', '-Fc'],
      { stdoutFile: join(partial, 'db.dump') },
    );
    await copyFile(p.env, join(partial, '.env'));
    await chmod(join(partial, '.env'), 0o600);
    await cp(p.compose, join(partial, 'compose'), { recursive: true });
    await writeFile(join(partial, 'version'), state.version);
    await rename(partial, dir);
  } catch (e) {
    await rm(partial, { recursive: true, force: true });
    throw e;
  }
  if (o.prune ?? true) {
    for (const old of (await listBackups(p.backups)).slice(0, -KEEP_BACKUPS)) {
      await rm(join(p.backups, old), { recursive: true, force: true });
    }
  }
  return dir;
}

/**
 * Replaces the database with a dump: the dump is checked with `pg_restore --list` before
 * anything is dropped, then a fresh database with the grants the init script made, then the data
 * in a single transaction (so a bad dump rolls back instead of leaving the database half-loaded).
 */
export async function restoreDatabase(compose: Compose, dumpFile: string): Promise<void> {
  const psql = ['exec', '-T', 'postgres', 'psql', '-U', 'agile', '-v', 'ON_ERROR_STOP=1'];
  await compose.check('restore', ['exec', '-T', 'postgres', 'pg_restore', '--list'], {
    stdinFile: dumpFile,
  });
  await compose.check('restore', [
    ...psql,
    '-d',
    'postgres',
    '-c',
    'DROP DATABASE IF EXISTS agile WITH (FORCE)',
    '-c',
    'CREATE DATABASE agile OWNER agile',
    '-c',
    'GRANT CONNECT ON DATABASE agile TO app_user',
  ]);
  await compose.check(
    'restore',
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'agile',
      '-d',
      'agile',
      '--exit-on-error',
      '--single-transaction',
    ],
    { stdinFile: dumpFile },
  );
  await compose.check('restore', [
    ...psql,
    '-d',
    'agile',
    '-c',
    'GRANT USAGE ON SCHEMA public TO app_user',
  ]);
}

async function installedState(ctx: Context): Promise<InstallState> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  return state;
}

export async function backupCommand(ctx: Context): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await installedState(ctx);
    const dir = await takeBackup(ctx, state, new Compose(ctx.docker, ctx.dataDir, state.mode));
    ctx.out(`✓ backup ${basename(dir)}`);
  } finally {
    await release();
  }
}

/** `name` is a folder in backups/ (as `status` shows it) or `latest`. */
export async function restoreCommand(
  ctx: Context,
  name: string,
  o: { yes: boolean },
): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await installedState(ctx);
    const p = pathsOf(ctx.dataDir);
    const chosen = name === 'latest' ? (await listBackups(p.backups)).at(-1) : basename(name);
    const dir =
      chosen && chosen !== '.' && chosen !== '..' && chosen === basename(chosen)
        ? join(p.backups, chosen)
        : null;
    if (!dir || !(await isCompleteBackup(dir))) {
      throw new UsageError(`No backup "${name}" in ${p.backups}.`);
    }
    if (
      !o.yes &&
      !(await ctx.prompt.confirm(
        `Replace the database with backup ${chosen}? Changes made since then are lost.`,
      ))
    ) {
      ctx.out('Cancelled.');
      return;
    }
    const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
    await compose.check('stop', ['stop', 'web', 'worker']);
    // The safety backup dumps from postgres, so it must be up before that, not just the app.
    await compose.check('postgres', ['up', '-d', 'postgres']);
    await waitService(ctx, compose, 'postgres');
    const safety = await takeBackup(ctx, state, compose, { prune: false });
    ctx.out(`✓ safety backup ${basename(safety)}`);
    await restoreDatabase(compose, join(dir, 'db.dump'));
    await copyFile(join(dir, '.env'), p.env);
    await chmod(p.env, 0o600);
    await rm(p.compose, { recursive: true, force: true });
    await cp(join(dir, 'compose'), p.compose, { recursive: true });
    const version = (await readFile(join(dir, 'version'), 'utf8')).trim();
    await writeState(ctx.dataDir, { ...state, version });
    await compose.check('start', ['up', '-d']);
    await waitHealthy(ctx, compose, state.mode);
    ctx.out(`✓ restored ${chosen} (${version})`);
  } finally {
    await release();
  }
}
