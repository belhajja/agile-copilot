import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** The names of the repo's own packages (`packages/*`), all TypeScript sources. */
function workspacePackages(): string[] {
  const dir = path.join(repoRoot, 'packages');
  return readdirSync(dir, { withFileTypes: true })
    .map((d) => path.join(dir, d.name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { name: string }).name)
    .sort();
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  // Every workspace package: they ship TypeScript sources and import one another.
  transpilePackages: workspacePackages(),
  // Node-only clients (database, queue, SMTP, email rendering): loaded at runtime, not bundled.
  serverExternalPackages: ['postgres', 'pg-boss', 'nodemailer', '@react-email/render'],
  // No other origin for images or connections (see src/csp.ts).
  headers: async () => securityHeaders(),
};

export default withNextIntl(config);
