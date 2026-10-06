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
  // Compose writes the containers' stdout and stderr to its own: both are shown, each with its
  // own buffer so a line split across chunks is redacted whole.
  const lineStream = () => {
    let pending = '';
    return {
      write(chunk: string) {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) ctx.out(redact(line, secrets));
      },
      flush() {
        if (pending) ctx.out(redact(pending, secrets));
        pending = '';
      },
    };
  };
  const stdout = lineStream();
  const stderr = lineStream();
  const args = [
    'logs',
    '--no-color',
    '--tail',
    '200',
    ...(follow ? ['--follow'] : []),
    ...(service ? [service] : []),
  ];
  try {
    await new Compose(ctx.docker, ctx.dataDir, state.mode).check('logs', args, {
      onStdout: stdout.write,
      onStderr: stderr.write,
    });
  } finally {
    stdout.flush();
    stderr.flush();
  }
}
