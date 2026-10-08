import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, parsePs, registryLogin, servicesOf } from '../docker';
import { parseEnv } from '../env-file';
import { StepError, UsageError } from '../errors';
import {
  APP_SERVICES,
  type AppService,
  localImages,
  runningImages,
  runsLatest,
  shortId,
} from '../images';
import { imagesFor } from '../stack';
import { pathsOf, readState } from '../state';
import { listBackups } from './backup';

/**
 * Version, services (with the image each app service runs), last backup and upgrade. `check`
 * pulls this operator's images and says whether `upgrade` would change anything.
 */
export async function status(ctx: Context, opts: { check?: boolean } = {}): Promise<void> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  const p = pathsOf(ctx.dataDir);
  const env = parseEnv(await readFile(p.env, 'utf8'));
  ctx.out(`Version  ${state.version} (${state.mode})`);
  ctx.out(`URL      ${env.get('BETTER_AUTH_URL') ?? '?'}`);
  // A failed `ps` (Docker unreachable, a broken compose file) is reported, not shown as every
  // service missing.
  const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
  const ps = await compose.check('status', ['ps', '-a', '--format', 'json']);
  const states = parsePs(ps.stdout);
  const running = await runningImages(compose);
  for (const service of servicesOf(state.mode)) {
    const s = states.find((x) => x.service === service);
    const detail = s ? `${s.state}${s.health ? `  ${s.health}` : ''}` : 'missing';
    const id = running.get(service as AppService);
    ctx.out(`  ${service.padEnd(24)}${detail}${id ? `  ${shortId(id)}` : ''}`);
  }
  ctx.out(`Backup   ${(await listBackups(p.backups)).at(-1) ?? 'none'}`);
  const last = state.history.at(-1);
  if (last) ctx.out(`Upgrade  ${last.from} → ${last.to}: ${last.result} (${last.at})`);
  if (!opts.check) return;

  const target = ctx.build.ref;
  const images = imagesFor(ctx.build);
  await registryLogin(ctx, env);
  for (const service of APP_SERVICES) {
    const r = await ctx.docker.run(['pull', images[service]]);
    if (r.code !== 0) throw new StepError('pull', `could not pull ${images[service]}`);
  }
  const latest = await localImages(ctx.docker, images);
  const sameNames = APP_SERVICES.every((s) => env.get(`${s.toUpperCase()}_IMAGE`) === images[s]);
  if (!sameNames) ctx.out(`Images   ${target} is available: run \`upgrade\``);
  else if (runsLatest(running, latest)) ctx.out(`Images   up to date (${target})`);
  else {
    const id = shortId(latest.get('web') ?? '');
    ctx.out(`Images   a newer ${target} build is available (${id}): run \`upgrade\``);
  }
}
