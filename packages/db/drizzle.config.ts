import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile',
  },
  strict: true,
  verbose: true,
});
