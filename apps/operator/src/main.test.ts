import { describe, expect, it } from 'vitest';
import { install } from './commands/install';
import { main } from './main';
import { tempContext } from './testing';

describe('main', () => {
  it('exits 2 with usage on an unknown command or flag', async () => {
    const { ctx, out } = await tempContext();
    expect(await main(['frobnicate'], ctx)).toBe(2);
    expect(out.join('\n')).toMatch(/Usage/);
    expect(await main(['install', '--nope'], ctx)).toBe(2);
  });

  it('exits 2 on a refused setting, 0 on success, 1 on a failed step', async () => {
    const ok = await tempContext();
    expect(await main(['install', '--yes', '--port', '99999'], ok.ctx)).toBe(2);
    expect(await main(['install', '--yes'], ok.ctx)).toBe(0);
    const failing = await tempContext({
      respond: (cmd) => (cmd === 'compose pull' ? { code: 1, stderr: 'denied' } : undefined),
    });
    expect(await main(['install', '--yes'], failing.ctx)).toBe(1);
    expect(failing.out.join('\n')).toMatch(/pull failed/);
  });

  it('redacts secrets from failure details', async () => {
    const { ctx, out, dataDir } = await tempContext({
      respond: (cmd) => (cmd === 'compose up -d' ? { code: 1, stderr: 'LEAK' } : undefined),
    });
    // The fake echoes the database password in the error: it must not reach the output.
    let leaked = '';
    ctx.docker = {
      run: async (args, _opts) => {
        const { readFile } = await import('node:fs/promises');
        const env = await readFile(`${dataDir}/.env`, 'utf8').catch(() => '');
        leaked = /POSTGRES_PASSWORD=(\w+)/.exec(env)?.[1] ?? leaked;
        const isUp = args.includes('up');
        return {
          code: isUp ? 1 : 0,
          stdout: '',
          stderr: isUp ? `password ${leaked} rejected` : '',
        };
      },
    };
    expect(await main(['install', '--yes'], ctx)).toBe(1);
    expect(leaked).not.toBe('');
    expect(out.join('\n')).not.toContain(leaked);
  });

  it('reports an unexpected error without a stack trace or a leaked secret', async () => {
    const { ctx, out, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    out.length = 0;
    // A plain rejection (not a StepError): a permission error reading .env, a docker.run that
    // throws instead of resolving, ... must still be reported, never rethrown as a stack trace.
    let leaked = '';
    ctx.docker = {
      run: async () => {
        const { readFile } = await import('node:fs/promises');
        const env = await readFile(`${dataDir}/.env`, 'utf8').catch(() => '');
        leaked = /POSTGRES_PASSWORD=(\w+)/.exec(env)?.[1] ?? leaked;
        throw new Error(`disk error near ${leaked}`);
      },
    };
    expect(await main(['status'], ctx)).toBe(1);
    expect(leaked).not.toBe('');
    expect(out.at(-1)).toMatch(/^✗ unexpected error/);
    expect(out.join('\n')).not.toContain(leaked);
  });
});
