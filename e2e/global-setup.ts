import { runMigrations } from '@agile/db';

export default async function globalSetup() {
  await runMigrations(
    process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile',
  );
  // Playwright only waits for 4010. Locally it may reuse a `pnpm mocks` started before the
  // mcp-atlassian double existed; fail early and clearly instead of in the agent tests.
  try {
    await fetch('http://127.0.0.1:4050/mcp');
  } catch {
    throw new Error(
      'The mcp-atlassian double is not listening on 127.0.0.1:4050. Stop the old `pnpm mocks` process (port 4010) and run the e2e suite again.',
    );
  }
}
