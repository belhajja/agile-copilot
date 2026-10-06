import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../errors';
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
});

describe('restore', () => {
  it('asks first and does nothing when the answer is no', async () => {
    const { ctx, docker } = await installed({ confirm: false });
    await backupCommand(ctx);
    docker.calls.length = 0;
    await restoreCommand(ctx, 'latest', { yes: false });
    expect(docker.commands).toEqual([]);
  });

  it('stops the app, recreates the database from the dump and starts again', async () => {
    const { ctx, docker } = await installed();
    await backupCommand(ctx);
    docker.calls.length = 0;
    await restoreCommand(ctx, 'latest', { yes: true });
    expect(docker.commands[0]).toBe('compose stop web worker');
    expect(docker.commands[1]).toMatch(/psql .*DROP DATABASE IF EXISTS agile WITH \(FORCE\)/);
    expect(docker.commands[2]).toBe(
      'compose exec -T postgres pg_restore -U agile -d agile --exit-on-error',
    );
    expect(docker.calls[2]?.opts?.stdinFile).toMatch(/db\.dump$/);
    expect(docker.commands).toContain('compose up -d');
  });

  it('only restores backups that exist in the backups folder', async () => {
    const { ctx } = await installed();
    await expect(restoreCommand(ctx, '../../etc', { yes: true })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(restoreCommand(ctx, 'latest', { yes: true })).rejects.toBeInstanceOf(UsageError);
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
