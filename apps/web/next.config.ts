import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { updateInitialEnv } from '@next/env';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './src/csp';

const repoRoot = path.join(import.meta.dirname, '../..');

// The README keeps one .env at the repo root, but Next only reads apps/web/.env*. Variables already
// set (e2e, Docker, CI, apps/web/.env*) win. Not `loadEnvConfig(repoRoot)`: Next has already called
// it for apps/web, so it returns that cached result without reading the root file;
// updateInitialEnv keeps these values when Next later reloads its env files.
const rootEnvFile = path.join(repoRoot, '.env');
if (existsSync(rootEnvFile)) {
  const missing = Object.fromEntries(
    Object.entries(parseEnv(readFileSync(rootEnvFile, 'utf8'))).filter(
      ([key]) => process.env[key] === undefined,
    ),
  );
  Object.assign(process.env, missing);
  updateInitialEnv(missing);
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  transpilePackages: [
    '@agile/agent',
    '@agile/analytics-mcp',
    '@agile/auth',
    '@agile/config',
    '@agile/connections',
    '@agile/crypto',
    '@agile/dashboards',
    '@agile/db',
    '@agile/jira',
    '@agile/jira-tools',
    '@agile/llm',
    '@agile/metrics',
    '@agile/net',
    '@agile/sync',
  ],
  // Node-only database clients: loaded at runtime instead of being bundled.
  serverExternalPackages: ['postgres', 'pg-boss'],
  // No other origin for images or connections (see src/csp.ts).
  headers: async () => securityHeaders(),
};

export default withNextIntl(config);
