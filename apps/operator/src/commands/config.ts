import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, waitHealthy } from '../docker';
import { renderEnv } from '../env-file';
import { UsageError } from '../errors';
import { type Mode, parseHostList, validateSettings } from '../settings';
import { acquireLock, pathsOf, readState, writeSecretFile } from '../state';

const integer = (key: string, min: number, max: number) => (v: string) => {
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new UsageError(`${key} must be a number from ${min} to ${max}.`);
  }
  return v;
};

/** What `config` may change, the .env keys each sets and the services that read them. */
export const CONFIG_KEYS: Record<
  string,
  { modes: Mode[]; services: string[]; values: (v: string) => Record<string, string> }
> = {
  'jira-hosts': {
    modes: ['local', 'server'],
    services: ['mcp-atlassian', 'mcp-atlassian-readonly', 'worker'],
    values: (v) => ({ MCP_ALLOWED_URL_DOMAINS: parseHostList('jira-hosts', v).join(',') }),
  },
  'private-hosts': {
    modes: ['local', 'server'],
    services: ['web', 'worker'],
    values: (v) => ({ ALLOWED_PRIVATE_HOSTS: parseHostList('private-hosts', v).join(',') }),
  },
  'trusted-proxy-hops': {
    modes: ['local', 'server'],
    services: ['web'],
    values: (v) => ({ TRUSTED_PROXY_HOPS: integer('trusted-proxy-hops', 0, 5)(v) }),
  },
  'skill-runs-daily-limit': {
    modes: ['local', 'server'],
    services: ['web', 'worker'],
    values: (v) => ({ SKILL_RUNS_DAILY_LIMIT: integer('skill-runs-daily-limit', 1, 10_000)(v) }),
  },
  port: {
    modes: ['local'],
    services: ['web', 'worker'],
    values: (v) => {
      const port = validateSettings({ port: v }).port;
      return { WEB_PORT: String(port), BETTER_AUTH_URL: `http://localhost:${port}` };
    },
  },
  domain: {
    modes: ['server'],
    services: ['web', 'worker', 'caddy'],
    values: (v) => {
      const s = validateSettings({ mode: 'server', domain: v, 'acme-email': 'unused@example.com' });
      return { APP_DOMAIN: s.domain ?? '', BETTER_AUTH_URL: `https://${s.domain}` };
    },
  },
};

export async function config(ctx: Context, key: string, value: string): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await readState(ctx.dataDir);
    if (!state) throw new UsageError('No install in this folder: run `install`.');
    const spec = CONFIG_KEYS[key];
    if (!spec)
      throw new UsageError(
        `Unknown setting "${key}". Settings: ${Object.keys(CONFIG_KEYS).join(', ')}.`,
      );
    if (!spec.modes.includes(state.mode)) {
      throw new UsageError(`"${key}" does not apply to a ${state.mode} install.`);
    }
    const values = spec.values(value);
    const p = pathsOf(ctx.dataDir);
    await writeSecretFile(p.env, renderEnv(values, await readFile(p.env, 'utf8')));
    const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
    await compose.check('restart', ['up', '-d', ...spec.services]);
    await waitHealthy(ctx, compose, state.mode);
    ctx.out(`✓ ${key} changed; restarted ${spec.services.join(', ')}`);
  } finally {
    await release();
  }
}
