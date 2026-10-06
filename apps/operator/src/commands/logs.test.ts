import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempContext } from '../testing';
import { install } from './install';
import { logs } from './logs';

describe('logs', () => {
  it('redacts a secret split across two stdout chunks', async () => {
    const { ctx, out, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    const env = await readFile(join(dataDir, '.env'), 'utf8');
    const secret = /POSTGRES_PASSWORD=(\w+)/.exec(env)?.[1] ?? '';
    expect(secret.length).toBeGreaterThan(4);
    out.length = 0;
    const half = Math.ceil(secret.length / 2);
    ctx.docker = {
      run: async (_args, opts) => {
        opts?.onStdout?.(`password ${secret.slice(0, half)}`);
        opts?.onStdout?.(`${secret.slice(half)} rejected\n`);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await logs(ctx, undefined, false);
    expect(out.join('\n')).not.toContain(secret);
    expect(out.join('\n')).toContain('password •••');
  });

  it('shows container stderr too, redacted', async () => {
    const { ctx, out, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    const env = await readFile(join(dataDir, '.env'), 'utf8');
    const secret = /POSTGRES_PASSWORD=(\w+)/.exec(env)?.[1] ?? '';
    out.length = 0;
    ctx.docker = {
      run: async (_args, opts) => {
        opts?.onStdout?.('web ready\n');
        opts?.onStderr?.(`postgres  | FATAL: password ${secret.slice(0, 5)}`);
        opts?.onStderr?.(`${secret.slice(5)} rejected\n`);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await logs(ctx, 'postgres', false);
    const text = out.join('\n');
    expect(text).toContain('web ready');
    expect(text).toContain('postgres  | FATAL: password ••• rejected');
    expect(text).not.toContain(secret);
  });
});
