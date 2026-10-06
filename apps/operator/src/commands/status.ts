import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, parsePs, servicesOf } from '../docker';
import { parseEnv } from '../env-file';
import { UsageError } from '../errors';
import { pathsOf, readState } from '../state';
import { listBackups } from './backup';

export async function status(ctx: Context): Promise<void> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  const p = pathsOf(ctx.dataDir);
  const env = parseEnv(await readFile(p.env, 'utf8'));
  ctx.out(`Version  ${state.version} (${state.mode})`);
  ctx.out(`URL      ${env.get('BETTER_AUTH_URL') ?? '?'}`);
  // A failed `ps` (Docker unreachable, a broken compose file) is reported, not shown as every
  // service missing.
  const ps = await new Compose(ctx.docker, ctx.dataDir, state.mode).check('status', [
    'ps',
    '-a',
    '--format',
    'json',
  ]);
  const states = parsePs(ps.stdout);
  for (const service of servicesOf(state.mode)) {
    const s = states.find((x) => x.service === service);
    const detail = s ? `${s.state}${s.health ? `  ${s.health}` : ''}` : 'missing';
    ctx.out(`  ${service.padEnd(24)}${detail}`);
  }
  ctx.out(`Backup   ${(await listBackups(p.backups)).at(-1) ?? 'none'}`);
  const last = state.history.at(-1);
  if (last) ctx.out(`Upgrade  ${last.from} → ${last.to}: ${last.result} (${last.at})`);
}
