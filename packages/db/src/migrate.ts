import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Built with path.join rather than `new URL('../drizzle', import.meta.url)`: bundlers (Next/Turbopack
// transpiles this package) treat that URL form as an asset import and fail to resolve a directory.
export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export async function runMigrations(ownerUrl: string, folder = migrationsFolder): Promise<void> {
  const client = postgres(ownerUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}
