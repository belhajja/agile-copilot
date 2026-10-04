import { defineConfig } from '@playwright/test';

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
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // `next dev` compiles each route on first hit; on shared CI runners that alone can exceed 5s.
  expect: { timeout: process.env.CI ? 30_000 : 5_000 },
  use: { baseURL: 'http://localhost:3200', trace: 'retain-on-failure' },
  webServer: [
    // 4010 opens last (after 4020, 4050, 4070 and 4080); global-setup checks that they answer.
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
      command: 'pnpm --filter @agile/web exec next dev --port 3200',
      url: 'http://localhost:3200/login',
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
