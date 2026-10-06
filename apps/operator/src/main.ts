import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { backupCommand, restoreCommand } from './commands/backup';
import { config } from './commands/config';
import { install } from './commands/install';
import { logs } from './commands/logs';
import { status } from './commands/status';
import { upgrade } from './commands/upgrade';
import type { Context } from './context';
import { parseEnv, redact, secretValues } from './env-file';
import { StepError, UsageError } from './errors';
import { type RawSettings, SETTING_KEYS, type SettingKey, SettingsError } from './settings';
import { LockedError, pathsOf } from './state';

export const USAGE = `Usage: operator <command> [options]

  install [--yes] [--resume] [--mode local|server] [--port N] [--domain D] [--acme-email E]
          [--jira-hosts H,..] [--private-hosts H,..] [--registry-user U --registry-token T]
          [--oidc-provider keycloak|oidc --oidc-issuer URL --oidc-client-id ID --oidc-client-secret S]
  upgrade              upgrade to this operator's version (backup first, rollback on failure)
  status               version, services, last backup and upgrade
  backup               back up the database with .env and the compose files
  restore <name|latest> [--yes]
  config <setting> <value>
  logs [service] [--follow]`;

async function secretsOf(ctx: Context): Promise<string[]> {
  const text = await readFile(pathsOf(ctx.dataDir).env, 'utf8').catch(() => '');
  return secretValues(parseEnv(text));
}

/** Runs one command. Exit codes: 0 success, 1 a step failed, 2 usage or a refused value. */
export async function main(argv: string[], ctx: Context): Promise<number> {
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
        ...settingOptions,
      },
    });
    const yes = Boolean(values.yes);
    switch (command) {
      case 'install': {
        const raw: RawSettings = {};
        for (const k of SETTING_KEYS) {
          const v = values[k];
          if (typeof v === 'string') raw[k] = v;
        }
        await install(ctx, raw, { yes, resume: Boolean(values.resume) });
        return 0;
      }
      case 'upgrade':
        await upgrade(ctx);
        return 0;
      case 'status':
        await status(ctx);
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
    throw e;
  }
}
