import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const repoRoot = path.join(import.meta.dirname, '../..');
// The README keeps one .env at the repo root; Next only reads apps/web/.env*. Variables already
// set in the process (e2e, Docker, CI) win: loadEnvConfig never overrides them.
loadEnvConfig(repoRoot);

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  transpilePackages: [
    '@agile/auth',
    '@agile/config',
    '@agile/connections',
    '@agile/crypto',
    '@agile/db',
    '@agile/jira',
    '@agile/llm',
    '@agile/net',
  ],
  serverExternalPackages: ['postgres'],
};

export default withNextIntl(config);
