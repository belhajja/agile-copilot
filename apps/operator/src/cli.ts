import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Context } from './context';
import { realDocker } from './docker';
import { main } from './main';
import type { Prompter } from './settings';

/** Prompts on the terminal; a secret answer is not echoed. */
const terminal: Prompter = {
  async ask(question, o = {}) {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
    const pending = rl.question(`? ${question}${o.default ? ` [${o.default}]` : ''}: `);
    muted = Boolean(o.secret);
    const answer = (await pending).trim();
    rl.close();
    if (o.secret) process.stdout.write('\n');
    return answer || o.default || '';
  },
  async confirm(question) {
    return /^y(es)?$/i.test(await terminal.ask(`${question} (yes/no)`, { default: 'no' }));
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const ctx: Context = {
  dataDir: process.env.OPERATOR_DATA_DIR ?? '/data',
  assetsDir: process.env.OPERATOR_ASSETS_DIR ?? join(here, '..', 'assets'),
  build: {
    ref: process.env.OPERATOR_VERSION ?? 'develop',
    imageBase:
      process.env.OPERATOR_IMAGE_BASE ??
      'registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai',
  },
  docker: realDocker,
  out: (line) => console.log(line),
  prompt: terminal,
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  healthTimeoutMs: 5 * 60 * 1000,
};

process.exitCode = await main(process.argv.slice(2), ctx);
