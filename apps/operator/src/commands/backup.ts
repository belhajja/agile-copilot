import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../context';
import { Compose, waitHealthy } from '../docker';
import { UsageError } from '../errors';
import { acquireLock, type InstallState, pathsOf, readState, writeState } from '../state';

export const KEEP_BACKUPS = 10;

/** Backup folder names, oldest first (they start with an ISO timestamp). */
export async function listBackups(backupsDir: string): Promise<string[]> {
  try {
    return (await readdir(backupsDir)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * The database (pg_dump custom format) with the .env and compose files of the same moment: the
 * .env holds ENCRYPTION_KEYS, without which the stored Jira and AI credentials cannot be read.
 */
export async function takeBackup(
  ctx: Context,
  state: InstallState,
  compose: Compose,
): Promise<string> {
  const p = pathsOf(ctx.dataDir);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const dir = join(p.backups, `${stamp}-${state.version.replace(/[^\w.-]/g, '_')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await compose.check(
    'backup',
    ['exec', '-T', 'postgres', 'pg_dump', '-U', 'agile', '-d', 'agile', '-Fc'],
    { stdoutFile: join(dir, 'db.dump') },
  );
  await copyFile(p.env, join(dir, '.env'));
  await chmod(join(dir, '.env'), 0o600);
  await cp(p.compose, join(dir, 'compose'), { recursive: true });
  await writeFile(join(dir, 'version'), state.version);
  for (const old of (await listBackups(p.backups)).slice(0, -KEEP_BACKUPS)) {
    await rm(join(p.backups, old), { recursive: true, force: true });
  }
  return dir;
}

/** Replaces the database with a dump: a fresh database, the grants the init script made, the data. */
export async function restoreDatabase(compose: Compose, dumpFile: string): Promise<void> {
  const psql = ['exec', '-T', 'postgres', 'psql', '-U', 'agile', '-v', 'ON_ERROR_STOP=1'];
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
    ['exec', '-T', 'postgres', 'pg_restore', '-U', 'agile', '-d', 'agile', '--exit-on-error'],
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
    const dir = chosen && chosen === basename(chosen) ? join(p.backups, chosen) : null;
    if (!dir || !(await stat(join(dir, 'db.dump')).catch(() => null))) {
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
    await restoreDatabase(compose, join(dir, 'db.dump'));
    await copyFile(join(dir, '.env'), p.env);
    await chmod(p.env, 0o600);
    await cp(join(dir, 'compose'), p.compose, { recursive: true, force: true });
    const version = (await readFile(join(dir, 'version'), 'utf8')).trim();
    await writeState(ctx.dataDir, { ...state, version });
    await compose.check('start', ['up', '-d']);
    await waitHealthy(ctx, compose, state.mode);
    ctx.out(`✓ restored ${chosen} (${version})`);
  } finally {
    await release();
  }
}
