import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from './context';
import { realDocker } from './docker';
import { main } from './main';
import { createPrompter } from './terminal';

const terminal = createPrompter(process.stdin, process.stdout);

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
