import { runMigrations } from '@agile/db';

export default async function globalSetup() {
  await runMigrations(
    process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile',
  );
}
