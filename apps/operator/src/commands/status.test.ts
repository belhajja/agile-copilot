import { describe, expect, it } from 'vitest';
import { StepError } from '../errors';
import { tempContext } from '../testing';
import { backupCommand } from './backup';
import { install } from './install';
import { status } from './status';

describe('status', () => {
  it('shows version, URL, services and the last backup, never a secret', async () => {
    const { ctx, out } = await tempContext();
    await install(ctx, { port: '3100' }, { yes: true, resume: false });
    await backupCommand(ctx);
    out.length = 0;
    await status(ctx);
    const text = out.join('\n');
    expect(text).toMatch(/Version\s+v1\.0\.0 \(local\)/);
    expect(text).toMatch(/URL\s+http:\/\/localhost:3100/);
    expect(text).toMatch(/web\s+running\s+healthy/);
    expect(text).toMatch(/Backup\s+2026-10-06T12-00/);
    expect(text).not.toMatch(/[0-9a-f]{48}/);
  });

  it('shows the image each app service runs, and with --check whether a newer one exists', async () => {
    const OLD = `sha256:${'a'.repeat(64)}`;
    let pulled = OLD;
    const { ctx, docker, out } = await tempContext({
      ref: 'develop',
      respond: (cmd) =>
        cmd === 'compose images --format json'
          ? {
              stdout: JSON.stringify(
                ['migrate', 'web', 'worker'].map((s) => ({
                  ContainerName: `agile-copilot-${s}-1`,
                  ID: OLD,
                })),
              ),
            }
          : cmd.startsWith('image inspect')
            ? { stdout: pulled }
            : undefined,
    });
    await install(ctx, {}, { yes: true, resume: false });
    out.length = 0;
    await status(ctx);
    expect(out.join('\n')).toMatch(/web\s+running\s+healthy\s+aaaaaaaaaaaa/);
    // Without --check nothing is pulled.
    expect(docker.commands.filter((c) => c.startsWith('pull'))).toEqual([]);

    out.length = 0;
    await status(ctx, { check: true });
    expect(out.at(-1)).toBe('Images   up to date (develop)');

    pulled = `sha256:${'b'.repeat(64)}`;
    out.length = 0;
    await status(ctx, { check: true });
    expect(out.at(-1)).toBe(
      'Images   a newer develop build is available (bbbbbbbbbbbb): run `upgrade`',
    );
  });

  it('reports a failed compose ps instead of showing every service missing', async () => {
    let fail = false;
    const { ctx, out } = await tempContext({
      respond: (cmd) =>
        fail && cmd.startsWith('compose ps')
          ? { code: 1, stderr: 'Cannot connect to the Docker daemon' }
          : undefined,
    });
    await install(ctx, {}, { yes: true, resume: false });
    fail = true;
    out.length = 0;
    await expect(status(ctx)).rejects.toMatchObject({
      constructor: StepError,
      detail: 'Cannot connect to the Docker daemon',
    });
    expect(out.join('\n')).not.toMatch(/missing/);
  });
});
