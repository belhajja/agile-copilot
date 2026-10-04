import { defineConfig } from '@playwright/test';

const env = {
  // CI points this at its Postgres service; locally it's the dev compose DB on 5433.
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    'postgres://app_user:app_user_dev_password@localhost:5433/agile',
  BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0000',
  BETTER_AUTH_URL: 'http://localhost:3200',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 9).toString('base64')}`,
  ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  use: { baseURL: 'http://localhost:3200', trace: 'retain-on-failure' },
  webServer: [
    { command: 'pnpm mocks', port: 4010, reuseExistingServer: !process.env.CI },
    {
      command: 'pnpm --filter @agile/web exec next dev --port 3200',
      url: 'http://localhost:3200/login',
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
