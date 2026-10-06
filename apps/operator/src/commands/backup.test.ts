import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StepError, UsageError } from '../errors';
import { readState } from '../state';
import { tempContext } from '../testing';
import { backupCommand, KEEP_BACKUPS, listBackups, restoreCommand } from './backup';
import { install } from './install';

const installed = async (o: Parameters<typeof tempContext>[0] = {}) => {
  const t = await tempContext(o);
  await install(t.ctx, {}, { yes: true, resume: false });
  t.docker.calls.length = 0;
  return t;
};

describe('backup', () => {
  it('dumps the database and keeps .env and the compose files with it', async () => {
    const { ctx, docker, dataDir } = await installed();
    await backupCommand(ctx);
    expect(docker.commands).toEqual(['compose exec -T postgres pg_dump -U agile -d agile -Fc']);
    const [name] = await listBackups(join(dataDir, 'backups'));
    const files = await readdir(join(dataDir, 'backups', name ?? ''));
    expect(files.sort()).toEqual(['.env', 'compose', 'db.dump', 'version']);
    expect(await readFile(join(dataDir, 'backups', name ?? '', 'version'), 'utf8')).toBe('v1.0.0');
  });

  it(`keeps the last ${KEEP_BACKUPS}`, async () => {
    const { ctx, dataDir } = await installed();
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
      await backupCommand(ctx);
      await ctx.sleep(1000);
    }
    expect(await listBackups(join(dataDir, 'backups'))).toHaveLength(KEEP_BACKUPS);
  });

  it('leaves nothing behind when the dump fails', async () => {
    const { ctx, dataDir } = await installed({
      respond: (cmd) =>
        cmd === 'compose exec -T postgres pg_dump -U agile -d agile -Fc'
          ? { code: 1, stderr: 'disk full' }
          : undefined,
    });
    await expect(backupCommand(ctx)).rejects.toThrow();
    expect(await readdir(join(dataDir, 'backups'))).toEqual([]);
    expect(await listBackups(join(dataDir, 'backups'))).toEqual([]);
  });

  it('ignores stray entries and partial backups', async () => {
    const { dataDir } = await installed();
    const backups = join(dataDir, 'backups');
    await mkdir(join(backups, 'lost+found'), { recursive: true });
    await mkdir(join(backups, '2026-01-01T00-00-00-000Z-v1.0.0.partial'), { recursive: true });
    expect(await listBackups(backups)).toEqual([]);
  });
});

describe('restore', () => {
  it('asks first and does nothing when the answer is no', async () => {
    const { ctx, docker } = await installed({ confirm: false });
    await backupCommand(ctx);
    docker.calls.length = 0;
    await restoreCommand(ctx, 'latest', { yes: false });
    expect(docker.commands).toEqual([]);
  });

  it('stops the app, takes a safety backup and recreates the database from the dump', async () => {
    const { ctx, docker, dataDir } = await installed();
    await backupCommand(ctx);
    docker.calls.length = 0;
    await restoreCommand(ctx, 'latest', { yes: true });
    expect(docker.commands[0]).toBe('compose stop web worker');
    expect(docker.commands[1]).toBe('compose up -d postgres');
    expect(docker.commands[2]).toBe('compose ps -a --format json');
    expect(docker.commands[3]).toBe('compose exec -T postgres pg_dump -U agile -d agile -Fc');
    expect(docker.commands[4]).toBe('compose exec -T postgres pg_restore --list');
    expect(docker.commands[5]).toMatch(/psql .*DROP DATABASE IF EXISTS agile WITH \(FORCE\)/);
    expect(docker.commands[6]).toBe(
      'compose exec -T postgres pg_restore -U agile -d agile --exit-on-error --single-transaction',
    );
    expect(docker.calls[6]?.opts?.stdinFile).toMatch(/db\.dump$/);
    expect(docker.commands).toContain('compose up -d');
    // the backup being restored and the safety backup taken along the way are both still there
    expect(await listBackups(join(dataDir, 'backups'))).toHaveLength(2);
  });

  it('checks the dump before dropping anything', async () => {
    const { ctx, docker } = await installed({
      respond: (cmd) =>
        cmd === 'compose exec -T postgres pg_restore --list'
          ? { code: 1, stderr: 'not a dump' }
          : undefined,
    });
    await backupCommand(ctx);
    docker.calls.length = 0;
    await expect(restoreCommand(ctx, 'latest', { yes: true })).rejects.toBeInstanceOf(StepError);
    expect(docker.commands.some((c) => c.includes('DROP DATABASE'))).toBe(false);
  });

  it('says the database was not changed when it fails before the drop', async () => {
    const { ctx, out } = await installed({
      respond: (cmd) =>
        cmd === 'compose exec -T postgres pg_restore --list'
          ? { code: 1, stderr: 'not a dump' }
          : undefined,
    });
    await backupCommand(ctx);
    const err = await restoreCommand(ctx, 'latest', { yes: true }).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.detail).toContain('not a dump');
    expect(err.detail).toMatch(/app is stopped.*database was not changed.*install --resume/);
    expect(out.join('\n')).toMatch(/install --resume/);
  });

  it('points at the safety backup when it fails after the drop', async () => {
    const { ctx, out, dataDir } = await installed({
      respond: (cmd) =>
        cmd.startsWith('compose exec -T postgres pg_restore -U agile')
          ? { code: 1, stderr: 'relation exists' }
          : undefined,
    });
    await backupCommand(ctx);
    const [original] = await listBackups(join(dataDir, 'backups'));
    const err = await restoreCommand(ctx, 'latest', { yes: true }).catch((e) => e);
    const safety = (await listBackups(join(dataDir, 'backups'))).find((b) => b !== original);
    expect(safety).toBeDefined();
    expect(err).toBeInstanceOf(StepError);
    expect(err.detail).toContain('relation exists');
    expect(err.detail).toMatch(/app is stopped/);
    expect(err.detail).toContain(`restore ${safety}`);
    expect(out.join('\n')).toContain(`restore ${safety}`);
  });

  it('only restores backups that exist in the backups folder', async () => {
    const { ctx } = await installed();
    await expect(restoreCommand(ctx, '../../etc', { yes: true })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(restoreCommand(ctx, 'latest', { yes: true })).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects "." and ".." as a backup name', async () => {
    const { ctx } = await installed();
    await backupCommand(ctx);
    await expect(restoreCommand(ctx, '.', { yes: true })).rejects.toBeInstanceOf(UsageError);
    await expect(restoreCommand(ctx, '..', { yes: true })).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses a backup outside the backups folder', async () => {
    const { ctx, dataDir } = await installed();
    const evil = join(dataDir, 'evil');
    await mkdir(join(evil, 'compose'), { recursive: true });
    await writeFile(join(evil, 'db.dump'), 'x');
    await writeFile(join(evil, '.env'), 'x');
    await writeFile(join(evil, 'version'), 'v1.0.0');
    await expect(restoreCommand(ctx, '../evil', { yes: true })).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses a backup missing a file', async () => {
    const { ctx, docker, dataDir } = await installed();
    await backupCommand(ctx);
    const [name] = await listBackups(join(dataDir, 'backups'));
    await rm(join(dataDir, 'backups', name ?? '', '.env'));
    docker.calls.length = 0;
    await expect(restoreCommand(ctx, 'latest', { yes: true })).rejects.toBeInstanceOf(UsageError);
    expect(docker.commands).toEqual([]);
  });

  it('puts back the version of the backup', async () => {
    const { ctx, dataDir } = await installed();
    await backupCommand(ctx);
    const state = await readState(dataDir);
    if (state) {
      state.version = 'v9.9.9';
      await (await import('../state')).writeState(dataDir, state);
    }
    await restoreCommand(ctx, 'latest', { yes: true });
    expect((await readState(dataDir))?.version).toBe('v1.0.0');
  });
});
