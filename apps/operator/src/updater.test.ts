import { describe, expect, it } from 'vitest';
import { tempContext } from './testing';
import { dataSource } from './updater';

describe('dataSource', () => {
  it("reads the install folder's host path from the operator's own container", async () => {
    const { ctx, docker } = await tempContext({
      respond: (cmd) =>
        cmd.startsWith('inspect')
          ? {
              stdout: JSON.stringify([
                { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
                { Source: '/run/desktop/mnt/host/c/agile-copilot', Destination: '/data' },
              ]),
            }
          : undefined,
    });
    ctx.dataDir = '/data';
    ctx.self = 'abc123';
    expect(await dataSource(ctx)).toBe('/run/desktop/mnt/host/c/agile-copilot');
    expect(docker.commands).toEqual(['inspect --format {{json .Mounts}} abc123']);
  });

  it('falls back to the folder itself outside a container, or when the inspect fails', async () => {
    const { ctx } = await tempContext({
      respond: (cmd) => (cmd.startsWith('inspect') ? { code: 1 } : undefined),
    });
    expect(await dataSource(ctx)).toBe(ctx.dataDir);
    ctx.self = 'abc123';
    expect(await dataSource(ctx)).toBe(ctx.dataDir);
  });
});
