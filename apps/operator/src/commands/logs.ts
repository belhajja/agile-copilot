import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose } from '../docker';
import { parseEnv, redact, secretValues } from '../env-file';
import { UsageError } from '../errors';
import { pathsOf, readState } from '../state';

/** The stack's logs with the secret values of .env masked, line by line. */
export async function logs(
  ctx: Context,
  service: string | undefined,
  follow: boolean,
): Promise<void> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  const secrets = secretValues(parseEnv(await readFile(pathsOf(ctx.dataDir).env, 'utf8')));
  let pending = '';
  const onStdout = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) ctx.out(redact(line, secrets));
  };
  const args = [
    'logs',
    '--no-color',
    '--tail',
    '200',
    ...(follow ? ['--follow'] : []),
    ...(service ? [service] : []),
  ];
  await new Compose(ctx.docker, ctx.dataDir, state.mode).check('logs', args, { onStdout });
  if (pending) ctx.out(redact(pending, secrets));
}
