import * as schema from '@agile/db';
import {
  type Db,
  deletedOrganizations,
  purgeOrgJobs,
  purgeOrgTenantRows,
  recordAudit,
  withOrg,
} from '@agile/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { organization } from 'better-auth/plugins/organization';
import { asc, eq } from 'drizzle-orm';
import { ac, orgRoles } from './access';
import { assertAssignableRole, assertSeatAvailable } from './assign';
import {
  auditMembership,
  checkInvitationListScope,
  guardInvitationList,
  redactFullOrganization,
  rememberBeforeState,
} from './hooks';
import { seatsInUse } from './members';
import {
  guardPasswordLogin,
  guardSsoStart,
  isBreakGlass,
  normalizeEmail,
  type PasswordLogin,
  type SsoConfig,
  ssoProviderConfig,
  ssoProviderId,
  verifiedEmailOfIdToken,
} from './sso';

/** Endpoints whose body carries a role to give. */
const ROLE_PATHS = new Set(['/organization/invite-member', '/organization/update-member-role']);

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
  /** The deployment's identity provider; unset = email and password only. */
  sso?: SsoConfig;
  /** Default `all`. `admin_only` keeps passwords for `breakGlassEmails` only. */
  passwordLogin?: PasswordLogin;
  /** Platform admin accounts that sign in with a password (break-glass when the IdP is down). */
  breakGlassEmails?: readonly string[];
  /**
   * Runs first when a workspace is deleted, before anything is purged (SaaS: cancel its Stripe
   * subscriptions and expire its open Checkout sessions). Throwing keeps the workspace.
   */
  beforeWorkspaceDeleted?: (orgId: string) => Promise<void>;
  /**
   * Seats a workspace's plan allows (members plus pending invitations); null = no limit (the
   * default, and self-host). Checked when someone is invited, added or accepts; never removes.
   */
  seatLimit?: (orgId: string) => Promise<number | null>;
}

/**
 * Builds the auth instance. With `sso`, better-auth discovers the identity provider while the
 * instance initialises; production code goes through `createAuthHolder`, which checks discovery
 * first (with a timeout) so a slow or absent IdP never holds up password or session requests.
 * `ssoProvider: false` keeps every SSO policy but leaves the provider out (IdP not reachable).
 */
export function createAuth(
  {
    db,
    secret,
    baseURL,
    sso,
    passwordLogin = 'all',
    breakGlassEmails = [],
    beforeWorkspaceDeleted = async () => {},
    seatLimit = async () => null,
  }: AuthOptions,
  { ssoProvider = true }: { ssoProvider?: boolean } = {},
) {
  const policy = { passwordLogin, breakGlassEmails };
  const memberCount = (orgId: string) =>
    db.$count(schema.member, eq(schema.member.organizationId, orgId));
  const ownerOf = async (userId: string) =>
    (
      await db
        .select({ email: schema.user.email, emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .limit(1)
    )[0];
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Explicit, so tests (where better-auth skips it by default) run the production checks:
    // trusted Origin on cookie requests, and callback URLs on our own origin.
    advanced: { disableOriginCheck: false },
    account: {
      // Access and refresh tokens are encrypted at rest with the auth secret (better-auth leaves
      // the ID token as is: it carries the identity claims, no grant).
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // An SSO identity joins an existing account by itself only when BOTH the identity provider
        // and our own records say the address is verified (password sign-ups never are), so
        // someone who registered a victim's address first cannot inherit the victim's SSO login.
        // Otherwise the user links it while signed in (Account settings), proving both.
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      },
    },
    hooks: {
      // The role exactly as the client sent it: better-auth trims and splits roles before its
      // organisation hooks see them (update-member-role), so they cannot see `' admin'`.
      before: createAuthMiddleware(async (ctx) => {
        guardSsoStart(ctx);
        guardPasswordLogin(ctx, policy);
        if (ROLE_PATHS.has(ctx.path)) assertAssignableRole(ctx.body?.role);
        await guardInvitationList(db, ctx);
        await rememberBeforeState(db, ctx);
      }),
      after: createAuthMiddleware(async (ctx) => {
        await checkInvitationListScope(db, ctx);
        await auditMembership(db, ctx);
        const redacted = await redactFullOrganization(db, ctx);
        if (redacted) return ctx.json(redacted);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Break-glass accounts are created by an operator with a password, never through SSO:
          // an IdP-created user would be an orphan the break-glass rules lock out of SSO (L20).
          before: async (newUser, ctx) => {
            if (isBreakGlass(newUser.email, breakGlassEmails) && ctx?.path !== '/sign-up/email') {
              return false;
            }
          },
        },
      },
      account: {
        create: {
          // Break-glass accounts stay password-only: they must work when the IdP is down or
          // compromised, so an SSO identity is never attached to them.
          before: async (newAccount) => {
            if (newAccount.providerId === 'credential') return;
            const owner = await ownerOf(newAccount.userId);
            if (owner && isBreakGlass(owner.email, breakGlassEmails)) return false;
          },
          // An identity linked from the IdP whose verified ID token vouches for this very address
          // proves it (M6): sign-ups already carry the IdP's flag, explicit links did not.
          after: async (created) => {
            if (!sso || created.providerId !== ssoProviderId(sso)) return;
            const vouched = verifiedEmailOfIdToken(created.idToken);
            const owner = await ownerOf(created.userId);
            if (!vouched || !owner || owner.emailVerified) return;
            if (isBreakGlass(owner.email, breakGlassEmails)) return;
            if (normalizeEmail(owner.email) !== vouched) return;
            await db
              .update(schema.user)
              .set({ emailVerified: true, updatedAt: new Date() })
              .where(eq(schema.user.id, created.userId));
          },
        },
      },
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
      // Always present (an empty list without SSO) so the auth API keeps one static type.
      genericOAuth({ config: sso && ssoProvider ? [ssoProviderConfig(sso)] : [] }),
      organization({
        allowUserToCreateOrganization: true,
        // With SSO, accepting an invitation needs an address the identity provider verified.
        // Without SSO no address is ever verified: link possession is the proof (M5 residual).
        requireEmailVerificationOnInvitation: Boolean(sso),
        ac,
        roles: orgRoles,
        organizationHooks: {
          // The role set is closed: owner, admin, manager, viewer (never better-auth's `member`).
          // Second layer behind `hooks.before`; `addMember` (server-only, no path) relies on it.
          // Plan seats (SaaS) are checked after the role, so a bad role keeps its own error.
          // A resend of a pending invitation skips this hook (it already holds a seat).
          beforeCreateInvitation: async ({ invitation }) => {
            const role = assertAssignableRole(invitation.role);
            const orgId = invitation.organizationId;
            // A pending invitation holds a seat.
            assertSeatAvailable(await seatLimit(orgId), await seatsInUse(db, orgId));
            return { data: { ...invitation, role } };
          },
          beforeAddMember: async ({ member }) => {
            const role = assertAssignableRole(member.role);
            const orgId = member.organizationId;
            // The creator of a new workspace (better-auth creates the organisation first): never
            // held to the plan, or a failing lookup would leave a workspace without its owner.
            const used = await memberCount(orgId);
            if (used > 0) assertSeatAvailable(await seatLimit(orgId), used);
            return { data: { ...member, role } };
          },
          // Checked again on acceptance (members only: the invitation's own seat is the one being
          // taken), as the plan may have shrunk since the invitation was sent.
          beforeAcceptInvitation: async ({ organization: org }) => {
            assertSeatAvailable(await seatLimit(org.id), await memberCount(org.id));
          },
          beforeUpdateMemberRole: async ({ newRole }) => ({
            data: { role: assertAssignableRole(newRole) },
          }),
          // Before, not after: if the purge fails the workspace is kept, so its encrypted secrets
          // are never left behind without an owner.
          beforeDeleteOrganization: async ({ organization: org, user }) => {
            // External state first (H2): if billing cannot be stopped, nothing is deleted, so a
            // workspace is never gone while still billed. The other way round is the safe one: if
            // the transaction below fails after Stripe was cancelled, the workspace stays without
            // a subscription (back on the free plan); the owner can subscribe again or retry.
            await beforeWorkspaceDeleted(org.id);
            await withOrg(db, org.id, async (tx) => {
              // Lock order shared with account deletion (@agile/privacy deleteAccount): the
              // workspace's member rows first, by id, before any tenant row. better-auth's own
              // order (crud-org.mjs: this hook, then adapter.deleteOrganization deleting member,
              // invitation, organization in its own transaction) takes them last, after our
              // purge, and could deadlock with an account deletion holding them.
              await tx
                .select({ id: schema.member.id })
                .from(schema.member)
                .where(eq(schema.member.organizationId, org.id))
                .orderBy(asc(schema.member.id))
                .for('update');
              // audit_log is append-only for the app role and holds no secrets: it is kept as the
              // record of the deletion, and the retention job purges it 90 days later
              // (deleted_organizations, purge_audit_log).
              await recordAudit(tx, {
                orgId: org.id,
                actorUserId: user.id,
                action: 'organization.deleted',
                targetType: 'organization',
                targetId: org.id,
              });
              await purgeOrgTenantRows(tx, org.id);
              // Its queued, running and finished jobs: none can run for it again.
              await purgeOrgJobs(tx, org.id);
              // The record and the organisation row go together (retention skips ids that still
              // exist in organization); members and invitations cascade. better-auth's own delete
              // that follows finds nothing left.
              await tx
                .insert(deletedOrganizations)
                .values({ deletedOrgId: org.id })
                .onConflictDoNothing();
              await tx.delete(schema.organization).where(eq(schema.organization.id, org.id));
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
