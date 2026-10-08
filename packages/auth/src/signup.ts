import { account, type Db, invitation, member, organization, user } from '@agile/db';
import { and, eq, gt } from 'drizzle-orm';
import { normalizeEmail, signUpRefused } from './sso';

/**
 * SIGNUP: `open` lets anyone create a password account and a workspace; `invite` creates password
 * accounts only for an address with a pending invitation (or the instance's very first account),
 * and workspaces only for the first one, existing owners and people the identity provider let in.
 */
export type SignupPolicy = 'open' | 'invite';

/** The instance has no account yet: its first one may always sign up (bootstrap). */
async function isFirstAccount(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: user.id }).from(user).limit(1);
  return !row;
}

async function hasPendingInvitation(db: Db, email: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, normalizeEmail(email)),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, now),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Before-hook for a password sign-up under `SIGNUP=invite`. Refused the same way as by the
 * password policy, whatever the address.
 */
export async function guardInviteOnlySignUp(db: Db, email: unknown): Promise<void> {
  if (await isFirstAccount(db)) return;
  if (typeof email === 'string' && (await hasPendingInvitation(db, email))) return;
  throw signUpRefused();
}

/**
 * Under `SIGNUP=invite`: who may create a workspace. The first one of the instance, anyone who
 * already owns one, and users who came through the identity provider (it decides who gets in).
 */
export async function mayCreateWorkspace(
  db: Db,
  userId: string,
  ssoProviderId: string | null,
): Promise<boolean> {
  const [anyWorkspace] = await db.select({ id: organization.id }).from(organization).limit(1);
  if (!anyWorkspace) return true;
  const [owner] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.role, 'owner')))
    .limit(1);
  if (owner) return true;
  if (!ssoProviderId) return false;
  const [sso] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, ssoProviderId)))
    .limit(1);
  return Boolean(sso);
}
