import { type Db, invitation, member, organization, user } from '@agile/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { parseRoles, primaryRole, type Role } from './roles';

export interface WorkspaceMember {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  /** Null for a role outside the four (never written since Phase 5). */
  role: Role | null;
  joinedAt: Date;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role | null;
  expiresAt: Date;
}

/** Members of one workspace, oldest first (for owners/admins and the members page). */
export async function listWorkspaceMembers(db: Db, orgId: string): Promise<WorkspaceMember[]> {
  const rows = await db
    .select({
      memberId: member.id,
      userId: member.userId,
      name: user.name,
      email: user.email,
      role: member.role,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
    .orderBy(asc(member.createdAt));
  return rows.map((r) => ({ ...r, role: primaryRole(parseRoles(r.role)) }));
}

/** Invitations still waiting for an answer (not expired). Only shown to owners and admins. */
export async function listPendingInvitations(
  db: Db,
  orgId: string,
  now = new Date(),
): Promise<PendingInvitation[]> {
  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, orgId),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, now),
      ),
    )
    .orderBy(asc(invitation.expiresAt));
  return rows.map((r) => ({ ...r, role: primaryRole(parseRoles(r.role ?? '')) }));
}

/** How many seats a workspace uses: members plus pending invitations (plan limits, Task 9). */
export async function seatsInUse(db: Db, orgId: string, now = new Date()): Promise<number> {
  const [members, pending] = await Promise.all([
    db.$count(member, eq(member.organizationId, orgId)),
    db.$count(
      invitation,
      and(
        eq(invitation.organizationId, orgId),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, now),
      ),
    ),
  ]);
  return members + pending;
}

export interface InvitationForUser {
  id: string;
  organizationName: string;
  role: Role | null;
  expiresAt: Date;
}

/**
 * Pending invitations addressed to an e-mail address, for the onboarding page. Callers pass only
 * an address the identity provider verified: anyone can type an unverified address at sign-up.
 */
export async function listInvitationsForEmail(
  db: Db,
  email: string,
  now = new Date(),
): Promise<InvitationForUser[]> {
  const rows = await db
    .select({
      id: invitation.id,
      organizationName: organization.name,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        eq(invitation.email, email.trim().toLowerCase()),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, now),
      ),
    )
    .orderBy(asc(invitation.expiresAt));
  return rows.map((r) => ({ ...r, role: primaryRole(parseRoles(r.role ?? '')) }));
}

/** A workspace's display name (null when it does not exist). */
export async function workspaceName(db: Db, orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId));
  return row?.name ?? null;
}
