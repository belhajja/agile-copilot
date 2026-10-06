import { describe, expect, it } from 'vitest';
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
});
