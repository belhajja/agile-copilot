import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env-file';
import { StepError, UsageError } from '../errors';
import { readState } from '../state';
import { psLines, type Responder, tempContext } from '../testing';
import { install } from './install';
import { upgrade } from './upgrade';

/** An install of v1.0.0, then a context for an operator of `ref` on the same folder. */
async function from100(ref: string, respond?: Responder) {
  const first = await tempContext();
  await install(first.ctx, {}, { yes: true, resume: false });
  const next = await tempContext({ ref, respond });
  next.ctx.dataDir = first.dataDir;
  return { ...next, dataDir: first.dataDir };
}

const envOf = async (dataDir: string) => parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));

describe('upgrade', () => {
  it('pulls, stops the app, backs up, switches images and waits for health', async () => {
    const { ctx, docker, dataDir } = await from100('v1.1.0');
    await upgrade(ctx);
    expect(docker.commands).toEqual([
      'compose ps -a --format json',
      'pull registry.example.com/agile/migrate:v1.1.0',
      'pull registry.example.com/agile/web:v1.1.0',
      'pull registry.example.com/agile/worker:v1.1.0',
      'compose stop web worker',
      'compose exec -T postgres pg_dump -U agile -d agile -Fc',
      'compose up -d',
      'compose ps -a --format json',
    ]);
    expect((await envOf(dataDir)).get('WEB_IMAGE')).toBe('registry.example.com/agile/web:v1.1.0');
    const state = await readState(dataDir);
    expect(state?.version).toBe('v1.1.0');
    expect(state?.history.at(-1)).toMatchObject({ from: 'v1.0.0', to: 'v1.1.0', result: 'ok' });
  });

  it('changes nothing when a pull fails', async () => {
    const { ctx, docker, dataDir } = await from100('v1.1.0', (cmd) =>
      cmd.startsWith('pull') ? { code: 1, stderr: 'not found' } : undefined,
    );
    await expect(upgrade(ctx)).rejects.toMatchObject({ step: 'pull' });
    expect(docker.commands.some((c) => c.startsWith('compose stop'))).toBe(false);
    expect((await readState(dataDir))?.version).toBe('v1.0.0');
  });

  it('rolls back to the previous version and data when the new version does not come up', async () => {
    let switched = false;
    const { ctx, docker, dataDir } = await from100('v1.1.0', (cmd) => {
      if (cmd === 'compose up -d' && !switched) {
        switched = true;
        return undefined;
      }
      if (
        cmd.startsWith('compose ps') &&
        switched &&
        !docker.commands.some((c) => c.includes('pg_restore'))
      ) {
        return { stdout: psLines({ migrate: { state: 'exited', exitCode: 1 } }) };
      }
      return undefined;
    });
    await expect(upgrade(ctx)).rejects.toBeInstanceOf(StepError);
    expect(docker.commands).toContain(
      'compose exec -T postgres pg_restore -U agile -d agile --exit-on-error --single-transaction',
    );
    expect((await envOf(dataDir)).get('WEB_IMAGE')).toBe('registry.example.com/agile/web:v1.0.0');
    const state = await readState(dataDir);
    expect(state?.version).toBe('v1.0.0');
    expect(state?.history.at(-1)).toMatchObject({ to: 'v1.1.0', result: 'rolled_back' });
  });

  it('refuses a downgrade', async () => {
    const { ctx, docker } = await from100('v0.9.0');
    await expect(upgrade(ctx)).rejects.toBeInstanceOf(UsageError);
    expect(docker.commands).toEqual([]);
  });

  it('does nothing on the same release', async () => {
    const { ctx, docker, out } = await from100('v1.0.0');
    await upgrade(ctx);
    expect(docker.commands).toEqual([]);
    expect(out.at(-1)).toMatch(/Already on v1\.0\.0/);
  });

  it('refuses to upgrade an unhealthy stack', async () => {
    const { ctx, docker } = await from100('v1.1.0', (cmd) =>
      cmd.startsWith('compose ps') ? { stdout: psLines({ web: { state: 'exited' } }) } : undefined,
    );
    await expect(upgrade(ctx)).rejects.toBeInstanceOf(UsageError);
    expect(docker.commands).toEqual(['compose ps -a --format json']);
  });
});
