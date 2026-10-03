import { createDb } from '@agile/db';
import { createAuth } from './server';

export const auth = createAuth({
  db: createDb('postgres://unused:unused@localhost:5432/unused').db,
  secret: 'cli-only-secret-not-used-at-runtime-000',
  baseURL: 'http://localhost:3000',
});
