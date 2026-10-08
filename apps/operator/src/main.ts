import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { backupCommand, restoreCommand } from './commands/backup';
import { config } from './commands/config';
import { install } from './commands/install';
import { logs } from './commands/logs';
import { status } from './commands/status';
import { upgrade } from './commands/upgrade';
import { watch } from './commands/watch';
import type { Context } from './context';
import { parseEnv, redact, secretValues } from './env-file';
import { StepError, UsageError } from './errors';
import { type RawSettings, SETTING_KEYS, type SettingKey, SettingsError } from './settings';
import { LockedError, pathsOf } from './state';

export const USAGE = `Usage: operator <command> [options]

  install [--yes] [--resume] [--mode local|server] [--port N] [--domain D] [--acme-email E]
          [--jira-hosts H,..] [--private-hosts H,..] [--registry-user U --registry-token T]
          [--oidc-provider keycloak|oidc --oidc-issuer URL --oidc-client-id ID --oidc-client-secret S]
  upgrade              upgrade to this operator's version (backup first, rollback on failure);
                       on a moving tag (develop) only when the registry has a newer build
  status [--check]     version, services and their images, last backup and upgrade; --check
                       pulls this operator's images and tells whether \`upgrade\` would change anything
  watch                the updater service: every AUTO_UPGRADE_INTERVAL_MINUTES (60), runs a
                       freshly pulled operator's \`upgrade\`; \`config auto-upgrade off\` pauses it
  backup               back up the database with .env and the compose files
  restore <name|latest> [--yes]
  config <setting> <value>
  logs [service] [--follow]

Secrets can come from the environment instead of the command line (kept out of the process list
and the shell history): OPERATOR_OIDC_CLIENT_SECRET and OPERATOR_REGISTRY_TOKEN are used when
--oidc-client-secret or --registry-token is absent. Without either, install asks for the OIDC
client secret on the terminal (docker run -it).`;

async function secretsOf(ctx: Context): Promise<string[]> {
  const text = await readFile(pathsOf(ctx.dataDir).env, 'utf8').catch(() => '');
  return secretValues(parseEnv(text));
}

/** Settings that may come from the environment when their flag is absent. */
const SECRET_ENV: Partial<Record<SettingKey, string>> = {
  'oidc-client-secret': 'OPERATOR_OIDC_CLIENT_SECRET',
  'registry-token': 'OPERATOR_REGISTRY_TOKEN',
};

/** Runs one command. Exit codes: 0 success, 1 a step failed, 2 usage or a refused value. */
export async function main(
  argv: string[],
  ctx: Context,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const settingOptions = Object.fromEntries(
      SETTING_KEYS.map((k) => [k, { type: 'string' as const }]),
    ) as Record<SettingKey, { type: 'string' }>;
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        yes: { type: 'boolean', default: false },
        resume: { type: 'boolean', default: false },
        follow: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        ...settingOptions,
      },
    });
    const yes = Boolean(values.yes);
    switch (command) {
      case 'install': {
        const raw: RawSettings = {};
        for (const k of SETTING_KEYS) {
          const name = SECRET_ENV[k];
          const v = values[k] ?? (name ? env[name] : undefined);
          if (typeof v === 'string') raw[k] = v;
        }
        await install(ctx, raw, { yes, resume: Boolean(values.resume) });
        return 0;
      }
      case 'upgrade':
        await upgrade(ctx);
        return 0;
      case 'watch':
        await watch(ctx);
        return 0;
      case 'status':
        await status(ctx, { check: Boolean(values.check) });
        return 0;
      case 'backup':
        await backupCommand(ctx);
        return 0;
      case 'restore':
        if (!positionals[0]) throw new UsageError('restore needs a backup name, or `latest`.');
        await restoreCommand(ctx, positionals[0], { yes });
        return 0;
      case 'config':
        if (positionals.length !== 2) throw new UsageError('config needs a setting and a value.');
        await config(ctx, positionals[0] ?? '', positionals[1] ?? '');
        return 0;
      case 'logs':
        await logs(ctx, positionals[0], Boolean(values.follow));
        return 0;
      default:
        ctx.out(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof StepError) {
      const detail = redact(e.detail, await secretsOf(ctx));
      ctx.out(`✗ ${e.step} failed${detail ? `: ${detail}` : ''}`);
      return 1;
    }
    if (e instanceof LockedError) {
      ctx.out(`✗ ${e.message}`);
      return 1;
    }
    if (e instanceof UsageError || e instanceof SettingsError) {
      ctx.out(`✗ ${e.message}`);
      return 2;
    }
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      ctx.out(`✗ ${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    // Anything else (a rejected docker.run, a permission error on .env, ...) is still ours to
    // report: never let a raw stack trace, possibly holding a secret, reach the console.
    const message = e instanceof Error ? e.message : String(e);
    ctx.out(`✗ unexpected error: ${redact(message, await secretsOf(ctx))}`);
    return 1;
  }
}
