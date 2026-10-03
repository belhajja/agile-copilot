import type { Db } from '@agile/db';
import * as schema from '@agile/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins/organization';

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
}

export function createAuth({ db, secret, baseURL }: AuthOptions) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    plugins: [organization({ allowUserToCreateOrganization: true }), nextCookies()], // nextCookies last
  });
}

export type Auth = ReturnType<typeof createAuth>;
