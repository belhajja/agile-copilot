import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, registryLogin, waitHealthy } from '../docker';
import { envFor, parseEnv, renderEnv } from '../env-file';
import { StepError, UsageError } from '../errors';
import { generateSecrets } from '../secrets';
import {
  gatherSettings,
  type RawSettings,
  registryOf,
  SETTING_KEYS,
  validateSettings,
} from '../settings';
import { imagesFor, writeStack } from '../stack';
import { acquireLock, pathsOf, readState, writeSecretFile, writeState } from '../state';

/**
 * On `--resume` only the registry credentials may change (a missing or wrong deploy token is a
 * common reason the first attempt failed); every other setting stays as the first attempt wrote it.
 */
async function resumeSettings(ctx: Context, raw: RawSettings): Promise<void> {
  const ignored = SETTING_KEYS.filter(
    (k) => raw[k] !== undefined && k !== 'registry-user' && k !== 'registry-token',
  );
  if (ignored.length > 0) {
    ctx.out(
      `Note: ${ignored.map((k) => `--${k}`).join(', ')} ignored on resume (use \`config\` later).`,
    );
  }
  const registry = registryOf(raw);
  if (!registry) return;
  const p = pathsOf(ctx.dataDir);
  await writeSecretFile(
    p.env,
    renderEnv(
      { OPERATOR_REGISTRY_USER: registry.user, OPERATOR_REGISTRY_TOKEN: registry.token },
      await readFile(p.env, 'utf8'),
    ),
  );
  ctx.out('✓ registry credentials updated');
}

export async function install(
  ctx: Context,
  raw: RawSettings,
  o: { yes: boolean; resume: boolean },
): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const p = pathsOf(ctx.dataDir);
    const existing = await readState(ctx.dataDir);
    if (existing && !o.resume) {
      throw new UsageError('This folder already has an install: use `upgrade` or `config`.');
    }
    if (!existing && o.resume) throw new UsageError('Nothing to resume here: run `install`.');

    let mode = existing?.mode ?? 'local';
    if (!existing) {
      // Everything is validated before the first file is written.
      const settings = validateSettings(await gatherSettings(raw, ctx.prompt, o.yes));
      mode = settings.mode;
      await writeStack(ctx.dataDir, mode, ctx.assetsDir);
      await writeSecretFile(
        p.env,
        renderEnv(envFor(settings, generateSecrets(), imagesFor(ctx.build))),
      );
      await writeState(ctx.dataDir, {
        version: ctx.build.ref,
        mode,
        installedAt: ctx.now().toISOString(),
        history: [],
      });
      ctx.out('✓ settings and secrets written');
    } else {
      await resumeSettings(ctx, raw);
    }

    const env = parseEnv(await readFile(p.env, 'utf8'));
    const compose = new Compose(ctx.docker, ctx.dataDir, mode);
    try {
      await registryLogin(ctx, env);
      await compose.check('pull', ['pull']);
      ctx.out('✓ images pulled');
      await compose.check('start', ['up', '-d']);
      await waitHealthy(ctx, compose, mode);
    } catch (e) {
      try {
        await compose.run(['stop']);
      } catch {
        // best effort: the original failure is the one to report.
      }
      if (e instanceof StepError && (e.step === 'registry login' || e.step === 'pull')) {
        ctx.out(
          'If the images need a deploy token: run `install --resume --registry-user <user> ' +
            '--registry-token <token>` (or put the token in OPERATOR_REGISTRY_TOKEN instead of ' +
            '--registry-token).',
        );
      } else {
        ctx.out('Fix the cause, then run `install --resume` (the settings and secrets are kept).');
      }
      throw e;
    }
    ctx.out(`✓ healthy: ${env.get('BETTER_AUTH_URL')}`);
    ctx.out('Next: create the first account, then add an AI model and Jira in Settings.');
  } finally {
    await release();
  }
}
