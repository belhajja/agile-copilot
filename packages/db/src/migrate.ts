import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(ownerUrl: string): Promise<void> {
  const client = postgres(ownerUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
