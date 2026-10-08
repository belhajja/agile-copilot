import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Responder, tempContext } from '../testing';
import { config } from './config';
import { install } from './install';
import { watch } from './watch';

/** An install of develop with a deploy token, then a watcher on the same folder. */
async function watched(respond?: Responder) {
  const first = await tempContext({ ref: 'develop' });
  await install(
    first.ctx,
    { 'registry-user': 'deploy', 'registry-token': 'gldt-secret-token' },
    { yes: true, resume: false },
  );
  const next = await tempContext({ ref: 'develop', respond });
  next.ctx.dataDir = first.dataDir;
  return { ...next, dataDir: first.dataDir };
}

const lastCheck = async (dataDir: string) =>
  JSON.parse(await readFile(join(dataDir, 'watch.json'), 'utf8')) as Record<string, string>;

const OPERATOR = 'registry.example.com/agile/operator/snapshot:develop';

describe('watch', () => {
  it('runs a freshly pulled operator to upgrade, with the socket and the install folder', async () => {
    const { ctx, docker, dataDir, out } = await watched((cmd) =>
      cmd.startsWith('run ')
        ? { stdout: '✓ new images pulled\n✓ upgraded to develop\n' }
        : undefined,
    );
    await watch(ctx, { once: true });
    expect(docker.commands).toEqual([
      'login registry.example.com --username deploy --password-stdin',
      `run --rm --pull always -v /var/run/docker.sock:/var/run/docker.sock -v ${dataDir}:/data ${OPERATOR} upgrade`,
    ]);
    expect(await lastCheck(dataDir)).toMatchObject({
      result: 'upgraded',
      detail: '✓ upgraded to develop',
    });
    expect(out.at(-1)).toMatch(/upgraded/);
  });

  it('records an up-to-date check', async () => {
    const { ctx, dataDir } = await watched((cmd) =>
      cmd.startsWith('run ')
        ? { stdout: 'Already up to date: develop (aaaaaaaaaaaa)\n' }
        : undefined,
    );
    await watch(ctx, { once: true });
    expect(await lastCheck(dataDir)).toMatchObject({ result: 'up_to_date' });
  });

  it('records a failed upgrade without the deploy token in it', async () => {
    const { ctx, dataDir } = await watched((cmd) =>
      cmd.startsWith('run ')
        ? { code: 1, stderr: 'pull failed with gldt-secret-token\n' }
        : undefined,
    );
    await watch(ctx, { once: true });
    const check = await lastCheck(dataDir);
    expect(check.result).toBe('failed');
    expect(JSON.stringify(check)).not.toContain('gldt-secret-token');
  });

  it('does nothing while automatic upgrades are off, and waits its interval between checks', async () => {
    const { ctx, docker, dataDir } = await watched();
    await config(ctx, 'auto-upgrade', 'off');
    docker.calls.length = 0;
    await watch(ctx, { once: true });
    expect(docker.commands).toEqual([]);
    expect(await lastCheck(dataDir)).toMatchObject({ result: 'off' });

    await config(ctx, 'auto-upgrade', 'on');
    await config(ctx, 'auto-upgrade-interval', '30');
    const slept: number[] = [];
    let rounds = 0;
    ctx.sleep = async (ms) => {
      slept.push(ms);
      rounds += 1;
      if (rounds === 2) throw new Error('stop');
    };
    await expect(watch(ctx)).rejects.toThrow('stop');
    expect(slept).toEqual([30 * 60_000, 30 * 60_000]);
  });

  it('refuses bad config values', async () => {
    const { ctx } = await watched();
    await expect(config(ctx, 'auto-upgrade', 'sometimes')).rejects.toThrow(/on or off/);
    await expect(config(ctx, 'auto-upgrade-interval', '1')).rejects.toThrow(/15 to 1440/);
  });
});
