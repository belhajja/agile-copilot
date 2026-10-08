import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// The standalone server node-build leaves as an artifact (static assets copied in, as in the
// image). CI sets E2E_PREBUILT_WEB=1 to serve it instead of building again; without it, or when
// it is missing, CI builds as before.
const prebuiltServer = fileURLToPath(
  new URL('../apps/web/.next/standalone/apps/web/server.js', import.meta.url),
);
const usePrebuilt =
  !!process.env.CI && process.env.E2E_PREBUILT_WEB === '1' && existsSync(prebuiltServer);

// Migrations run as the owner; the worker starts before globalSetup, so it migrates first.
const ownerUrl =
  process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile';

const env = {
  // CI points this at its Postgres service; locally it's the dev compose DB on 5433.
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    'postgres://app_user:app_user_dev_password@localhost:5433/agile',
  BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0000',
  BETTER_AUTH_URL: 'http://localhost:3200',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 9).toString('base64')}`,
  ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
  // The mcp-atlassian test doubles started by `pnpm mocks`: the read-write instance (chat) and the
  // read-only twin (skill runs in the worker, previews in the web app), on the same port.
  MCP_ATLASSIAN_URL: 'http://127.0.0.1:4050/mcp',
  MCP_ATLASSIAN_READONLY_URL: 'http://127.0.0.1:4050/readonly/mcp',
  // Single sign-on against the mock OIDC provider (`pnpm mocks`, port 4090). Passwords stay on
  // for everyone (PASSWORD_LOGIN=all): the other specs sign up with a password; `admin_only` is
  // covered by Vitest.
  OIDC_PROVIDER: 'oidc',
  // oauth2-mock-server names its issuer `localhost` (it listens on 127.0.0.1); discovery must match.
  OIDC_ISSUER: 'http://localhost:4090',
  OIDC_CLIENT_ID: 'agile-e2e',
  OIDC_CLIENT_SECRET: 'agile-e2e-secret',
  OIDC_DISPLAY_NAME: 'Acme SSO',
  PASSWORD_LOGIN: 'all',
  // The specs sign people up without invitations.
  SIGNUP: 'open',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // `next dev` compiles each route on first hit; on shared CI runners that alone can exceed 5s.
  expect: { timeout: process.env.CI ? 30_000 : 5_000 },
  use: { baseURL: 'http://localhost:3200', trace: 'retain-on-failure' },
  webServer: [
    // 4010 opens last (after 4020, 4050, 4070, 4080 and 4090); global-setup checks that they answer.
    { command: 'pnpm mocks', port: 4010, reuseExistingServer: !process.env.CI },
    {
      // The sync worker (pg-boss); its /health answers once it is connected and scheduled.
      // Playwright starts web servers before globalSetup, so the schema is migrated here first.
      command: 'pnpm --filter @agile/db migrate && pnpm --filter @agile/worker start',
      url: 'http://127.0.0.1:4030/health',
      env: {
        ...env,
        DATABASE_OWNER_URL: ownerUrl,
        WORKER_HEALTH_PORT: '4030',
        SYNC_INTERVAL_MINUTES: '60',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // CI serves a production build: `next dev` compiles each route on its first request, which
      // under every worker at once outlasted a test's 30 s on the shared runners.
      command: usePrebuilt
        ? `node ${JSON.stringify(prebuiltServer)}`
        : process.env.CI
          ? 'pnpm --filter @agile/web build && pnpm --filter @agile/web exec next start --port 3200'
          : 'pnpm --filter @agile/web exec next dev --port 3200',
      url: 'http://localhost:3200/login',
      // server.js reads PORT and HOSTNAME; HOSTNAME is the container's name on CI runners.
      env: usePrebuilt ? { ...env, PORT: '3200', HOSTNAME: '0.0.0.0' } : env,
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 600_000 : 180_000,
    },
  ],
});
