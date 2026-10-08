import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web', 'apps/worker'],
    // Shared Postgres for the database tests (see packages/db/src/testing.ts).
    globalSetup: ['packages/db/src/vitest-global-setup.ts'],
  },
});
