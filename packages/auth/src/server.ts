import * as schema from '@agile/db';
import { auditLog, type Db, purgeOrgTenantRows, withOrg } from '@agile/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins/organization';
import { asc, eq } from 'drizzle-orm';
import { ac, orgRoles } from './access';
import { assertAssignableRole } from './assign';

/** Endpoints whose body carries a role to give. */
const ROLE_PATHS = new Set(['/organization/invite-member', '/organization/update-member-role']);

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
    hooks: {
      // The role exactly as the client sent it: better-auth trims and splits roles before its
      // organisation hooks see them (update-member-role), so they cannot see `' admin'`.
      before: createAuthMiddleware(async (ctx) => {
        if (ROLE_PATHS.has(ctx.path)) assertAssignableRole(ctx.body?.role);
      }),
    },
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
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        ac,
        roles: orgRoles,
        organizationHooks: {
          // The role set is closed: owner, admin, manager, viewer (never better-auth's `member`).
          // Second layer behind `hooks.before`; `addMember` (server-only, no path) relies on it.
          beforeCreateInvitation: async ({ invitation }) => ({
            data: { ...invitation, role: assertAssignableRole(invitation.role) },
          }),
          beforeAddMember: async ({ member }) => ({
            data: { ...member, role: assertAssignableRole(member.role) },
          }),
          beforeUpdateMemberRole: async ({ newRole }) => ({
            data: { role: assertAssignableRole(newRole) },
          }),
          // Before, not after: if the purge fails the workspace is kept, so its encrypted secrets
          // are never left behind without an owner.
          beforeDeleteOrganization: async ({ organization: org, user }) => {
            await withOrg(db, org.id, async (tx) => {
              // audit_log is append-only (app_user cannot delete from it) and holds no secrets; it is
              // kept as the record of the deletion. Retention purges arrive with Phase 5.
              await tx.insert(auditLog).values({
                orgId: org.id,
                actorUserId: user.id,
                action: 'organization.deleted',
                targetType: 'organization',
                targetId: org.id,
              });
              await purgeOrgTenantRows(tx, org.id);
            });
          },
        },
      }),
      nextCookies(), // must stay last
    ],
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
