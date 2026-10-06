import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { UsageError } from './errors';
import type { Prompter } from './settings';

type Input = NodeJS.ReadableStream & { isTTY?: boolean };

/**
 * Prompts on a terminal; a secret answer is not echoed. Refuses instead of waiting forever when
 * stdin is not a TTY (`docker run` without `-it`, a non-interactive CI shell): `readline`'s
 * `question()` never settles on a closed or empty pipe.
 */
export function createPrompter(stdin: Input, stdout: NodeJS.WritableStream): Prompter {
  const prompter: Prompter = {
    async ask(question, o = {}) {
      if (!stdin.isTTY) {
        throw new UsageError(
          `No terminal to answer "${question}": run with -it, or pass the answer as a flag ` +
            '(--yes takes the defaults; see the usage).',
        );
      }
      let muted = false;
      const output = new Writable({
        write(chunk, _encoding, done) {
          if (!muted) stdout.write(chunk);
          done();
        },
      });
      const rl = createInterface({ input: stdin, output, terminal: true });
      const pending = rl.question(`? ${question}${o.default ? ` [${o.default}]` : ''}: `);
      muted = Boolean(o.secret);
      const answer = (await pending).trim();
      rl.close();
      if (o.secret) stdout.write('\n');
      return answer || o.default || '';
    },
    async confirm(question) {
      if (!stdin.isTTY) {
        throw new UsageError(
          `No terminal to answer "${question}": run with -it, or pass --yes to take the defaults.`,
        );
      }
      return /^y(es)?$/i.test(await prompter.ask(`${question} (yes/no)`, { default: 'no' }));
    },
  };
  return prompter;
}
