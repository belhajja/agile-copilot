import { runMigrations } from './migrate';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is required to run migrations');
  process.exit(1);
}
await runMigrations(url);
console.log('Migrations applied');
