import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../context';
import { registryLogin } from '../docker';
import { parseEnv, redact, secretValues } from '../env-file';
import { describeError } from '../errors';
import { pathsOf, readState } from '../state';

/** Minutes between two checks when AUTO_UPGRADE_INTERVAL_MINUTES is not set. */
export const DEFAULT_INTERVAL_MINUTES = 60;

/** What the last check did, kept in /data/watch.json for `status`. */
export interface LastCheck {
  at: string;
  result: 'up_to_date' | 'upgraded' | 'skipped' | 'failed' | 'off';
  detail: string;
}

export const watchFile = (dataDir: string) => join(dataDir, 'watch.json');

export async function readLastCheck(dataDir: string): Promise<LastCheck | null> {
  try {
    return JSON.parse(await readFile(watchFile(dataDir), 'utf8')) as LastCheck;
  } catch {
    return null;
  }
}

export function intervalMinutes(env: Map<string, string>): number {
  const n = Number(env.get('AUTO_UPGRADE_INTERVAL_MINUTES'));
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INTERVAL_MINUTES;
}

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * One check: a freshly pulled operator of the installed tag runs `upgrade` against this install,
 * as a sibling container (so the updater, which that upgrade may recreate, is never the one
 * running it). `upgrade` itself does nothing when the registry has no newer build.
 */
async function check(ctx: Context): Promise<LastCheck> {
  const at = ctx.now().toISOString();
  if (!(await readState(ctx.dataDir))) return { at, result: 'skipped', detail: 'no install here' };
  const env = parseEnv(await readFile(pathsOf(ctx.dataDir).env, 'utf8'));
  if (env.get('AUTO_UPGRADE') === 'off') return { at, result: 'off', detail: '' };
  const image = env.get('OPERATOR_IMAGE');
  const source = env.get('OPERATOR_DATA_SOURCE');
  if (!image || !source) {
    return { at, result: 'failed', detail: 'OPERATOR_IMAGE or OPERATOR_DATA_SOURCE missing' };
  }
  const secrets = secretValues(env);
  try {
    await registryLogin(ctx, env);
    const r = await ctx.docker.run([
      'run',
      '--rm',
      '--pull',
      'always',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${source}:/data`,
      image,
      'upgrade',
    ]);
    const detail = redact(lastLine(`${r.stdout}\n${r.stderr}`), secrets);
    if (r.code === 0) {
      return {
        at,
        result: /Already up to date/.test(r.stdout) ? 'up_to_date' : 'upgraded',
        detail,
      };
    }
    // 2: refused (an unhealthy stack, another upgrade holding the lock); it is tried again later.
    return { at, result: r.code === 2 ? 'skipped' : 'failed', detail };
  } catch (e) {
    return { at, result: 'failed', detail: redact(describeError(e), secrets) };
  }
}

/**
 * The updater service: waits the interval, checks, records the result, forever (`once`: one check,
 * now). The wait comes first, so a restart (a reboot, `install` itself) never starts an upgrade.
 */
export async function watch(ctx: Context, o: { once?: boolean } = {}): Promise<void> {
  for (;;) {
    if (!o.once) {
      const env = parseEnv(await readFile(pathsOf(ctx.dataDir).env, 'utf8').catch(() => ''));
      await ctx.sleep(intervalMinutes(env) * 60_000);
    }
    const last = await check(ctx);
    await writeFile(watchFile(ctx.dataDir), `${JSON.stringify(last)}\n`);
    ctx.out(`${last.at} ${last.result}${last.detail ? `: ${last.detail}` : ''}`);
    if (o.once) return;
  }
}
