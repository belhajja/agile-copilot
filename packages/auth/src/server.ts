import type { Db } from '@agile/db';
import * as schema from '@agile/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins/organization';
import { asc, eq } from 'drizzle-orm';

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
    databaseHooks: {
      session: {
        create: {
          // New sessions start with no active org; resume the user's first workspace so signing
          // back in lands on the app instead of onboarding.
          before: async (session) => ({
            data: { ...session, activeOrganizationId: await firstOrgId(db, session.userId) },
          }),
        },
      },
    },
    plugins: [organization({ allowUserToCreateOrganization: true }), nextCookies()], // nextCookies last
  });
}

async function firstOrgId(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt))
    .limit(1);
  return row?.orgId ?? null;
}

export type Auth = ReturnType<typeof createAuth>;
