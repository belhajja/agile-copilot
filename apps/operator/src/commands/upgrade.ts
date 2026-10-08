import { chmod, copyFile, cp, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../context';
import {
  Compose,
  parsePs,
  registryLogin,
  servicesOf,
  stackHealth,
  waitHealthy,
  waitService,
} from '../docker';
import { parseEnv, renderEnv } from '../env-file';
import { describeError, StepError, UsageError } from '../errors';
import {
  APP_SERVICES,
  type AppService,
  localImages,
  runningImages,
  runsLatest,
  shortId,
} from '../images';
import { compareVersions, imagesFor, isRelease, writeStack } from '../stack';
import {
  acquireLock,
  type HistoryEntry,
  type InstallState,
  pathsOf,
  readState,
  writeSecretFile,
  writeState,
} from '../state';
import { restoreDatabase, takeBackup } from './backup';

async function record(
  ctx: Context,
  state: InstallState,
  to: string,
  result: HistoryEntry['result'],
  images?: Map<AppService, string>,
) {
  const entry: HistoryEntry = { from: state.version, to, at: ctx.now().toISOString(), result };
  if (images && images.size > 0) {
    entry.images = Object.fromEntries([...images].map(([s, id]) => [s, shortId(id)]));
  }
  await writeState(ctx.dataDir, {
    ...state,
    version: result === 'ok' ? to : state.version,
    history: [...state.history, entry],
  });
}

/**
 * Restarts the app after `stop` or the backup failed. The original failure (`cause`) is what gets
 * thrown; a restart that also fails is folded into that error instead of replacing it, so the
 * caller never loses why the upgrade stopped.
 */
async function restartOrFail(compose: Compose, cause: unknown): Promise<never> {
  let restarted: boolean;
  try {
    restarted = (await compose.run(['up', '-d'])).code === 0;
  } catch {
    restarted = false;
  }
  if (!restarted) {
    throw new StepError(
      'upgrade',
      `${describeError(cause)}; the app is stopped and did not restart. The database was not ` +
        'changed: run `install --resume` to bring it back up, then `upgrade` again once the cause is fixed.',
    );
  }
  throw cause;
}

/**
 * Back to the files and data of `backupDir`, on the images still on this host. A moving tag
 * (`develop`) already points to the new build after the pull: the images the app ran before
 * (`previous`, by ID) are tagged again under the names the restored .env uses.
 */
async function rollback(
  ctx: Context,
  state: InstallState,
  compose: Compose,
  backupDir: string,
  previous: Map<AppService, string>,
) {
  const p = pathsOf(ctx.dataDir);
  await compose.run(['stop', 'web', 'worker', 'migrate']);
  // Copied next to the live folder and swapped in only once complete, so a failed copy never
  // leaves the install without any compose folder at all.
  const nextCompose = `${p.compose}.rollback`;
  await rm(nextCompose, { recursive: true, force: true });
  await cp(join(backupDir, 'compose'), nextCompose, { recursive: true });
  await rm(p.compose, { recursive: true, force: true });
  await rename(nextCompose, p.compose);
  await copyFile(join(backupDir, '.env'), p.env);
  await chmod(p.env, 0o600);
  const env = parseEnv(await readFile(p.env, 'utf8'));
  for (const service of APP_SERVICES) {
    const id = previous.get(service);
    const ref = env.get(`${service.toUpperCase()}_IMAGE`);
    if (id && ref) await ctx.docker.run(['tag', id, ref]);
  }
  // postgres on the images still on this host, up and healthy before anything is restored to it.
  await compose.check('postgres', ['up', '-d', 'postgres']);
  await waitService(ctx, compose, 'postgres');
  await restoreDatabase(compose, join(backupDir, 'db.dump'));
  await compose.check('rollback', ['up', '-d']);
  await waitHealthy(ctx, compose, state.mode);
}

/** Upgrades the install to this operator's version. */
export async function upgrade(ctx: Context): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await readState(ctx.dataDir);
    if (!state) throw new UsageError('No install in this folder: run `install`.');
    const target = ctx.build.ref;
    if (isRelease(target) && isRelease(state.version)) {
      const order = compareVersions(target, state.version);
      if (order === 0) {
        ctx.out(`Already on ${target}.`);
        return;
      }
      if (order < 0) {
        throw new UsageError(
          `${state.version} is installed, newer than this operator (${target}): migrations only go forward. Use a newer operator, or restore a backup.`,
        );
      }
    }

    const p = pathsOf(ctx.dataDir);
    const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
    const ps = await compose.check('status', ['ps', '-a', '--format', 'json']);
    if (!stackHealth(parsePs(ps.stdout), servicesOf(state.mode)).ready) {
      throw new UsageError('The stack is not healthy: fix it first (see `status`), then upgrade.');
    }

    const envText = await readFile(p.env, 'utf8');
    const env = parseEnv(envText);
    // What runs now, by image ID: a moving tag can point to another build after the pull.
    const previous = await runningImages(compose);
    await registryLogin(ctx, env);
    // Pulled before anything stops: a failed pull changes nothing.
    const images = imagesFor(ctx.build);
    for (const image of [images.migrate, images.web, images.worker]) {
      const r = await ctx.docker.run(['pull', image]);
      if (r.code !== 0) throw new StepError('pull', `could not pull ${image}`);
    }
    const latest = await localImages(ctx.docker, images);
    const sameNames = APP_SERVICES.every((s) => env.get(`${s.toUpperCase()}_IMAGE`) === images[s]);
    if (sameNames && runsLatest(previous, latest)) {
      ctx.out(`Already up to date: ${target} (${shortId(latest.get('web') ?? '')})`);
      return;
    }
    ctx.out('✓ new images pulled');

    // The app stops before the backup, so the backup holds every change. A stop that only half
    // worked, or a backup that fails, must not leave the app down with no way back up.
    try {
      await compose.check('stop', ['stop', 'web', 'worker']);
    } catch (e) {
      await restartOrFail(compose, e);
      throw e;
    }
    let backupDir: string;
    try {
      backupDir = await takeBackup(ctx, state, compose);
    } catch (e) {
      await restartOrFail(compose, e);
      throw e;
    }
    ctx.out(`✓ backup ${basename(backupDir)}`);

    try {
      await writeStack(ctx.dataDir, state.mode, ctx.assetsDir);
      await writeSecretFile(
        p.env,
        renderEnv(
          { WEB_IMAGE: images.web, WORKER_IMAGE: images.worker, MIGRATE_IMAGE: images.migrate },
          envText,
        ),
      );
      await compose.check('start', ['up', '-d']);
      await waitHealthy(ctx, compose, state.mode);
    } catch (e) {
      ctx.out(`✗ ${target} did not come up: rolling back to ${state.version}`);
      try {
        await rollback(ctx, state, compose, backupDir, previous);
      } catch (rollbackErr) {
        ctx.out(`✗ rollback failed too: run \`restore ${basename(backupDir)}\``);
        try {
          await record(ctx, state, target, 'rollback_failed');
        } catch {
          // best effort: the advice above and both errors below must stand regardless.
        }
        throw new StepError(
          'rollback',
          `upgrade: ${describeError(e)}; rollback: ${describeError(rollbackErr)}; ` +
            `run \`restore ${basename(backupDir)}\``,
        );
      }
      await record(ctx, state, target, 'rolled_back');
      ctx.out(`✓ back on ${state.version}`);
      throw e;
    }
    await record(ctx, state, target, 'ok', latest);
    ctx.out(`✓ upgraded to ${target}`);
  } finally {
    await release();
  }
}
