import {
  type AuditAction,
  type Db,
  invitation as invitationTable,
  member as memberTable,
  recordAudit,
  withOrg,
} from '@agile/db';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { and, eq, gt } from 'drizzle-orm';
import { can, getMemberRoles } from './roles';

/** What the auth middleware sees of an endpoint call (the fields we read). */
export interface HookContext {
  path?: string;
  body?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  context: { returned?: unknown };
}
/** What the before-hook learns that the after-hook cannot read back (same request context). */
interface Before {
  previousRole?: string;
  resend?: boolean;
}
const beforeState = new WeakMap<object, Before>();
interface SessionLike {
  activeOrganizationId?: string | null;
  [key: string]: unknown;
}

/**
 * The session of the request a hook runs for. HookContext only declares what these hooks read;
 * better-auth passes its full endpoint context, which is what getSessionFromCtx needs.
 */
const sessionOf = (ctx: HookContext) =>
  getSessionFromCtx(ctx as unknown as Parameters<typeof getSessionFromCtx>[0]);

/** Audit actions written for membership changes, whichever client made them. */
export type MemberAuditAction = Extract<AuditAction, `member.${string}`>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Error);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * One audit row per successful membership change. Reads the endpoint's own result (never the
 * request body for ids that could be forged): metadata holds ids and roles, never emails.
 */
function memberAuditEntry(
  path: string,
  returned: unknown,
  before: Before,
): { action: MemberAuditAction; orgId: string; targetId: string; meta: object } | null {
  if (!isRecord(returned)) return null;
  const member = isRecord(returned.member) ? returned.member : returned;
  const invitation = isRecord(returned.invitation) ? returned.invitation : returned;
  switch (path) {
    case '/organization/invite-member': {
      const orgId = str(invitation.organizationId);
      const id = str(invitation.id);
      return orgId && id
        ? {
            action: before.resend ? 'member.invite_resent' : 'member.invited',
            orgId,
            targetId: id,
            meta: { role: invitation.role },
          }
        : null;
    }
    case '/organization/cancel-invitation': {
      const orgId = str(invitation.organizationId);
      const id = str(invitation.id);
      return orgId && id
        ? { action: 'member.invitation_cancelled', orgId, targetId: id, meta: {} }
        : null;
    }
    case '/organization/accept-invitation': {
      const orgId = str(member.organizationId);
      const id = str(member.userId);
      return orgId && id
        ? {
            action: 'member.joined',
            orgId,
            targetId: id,
            meta: { role: member.role, invitationId: str(invitation.id) },
          }
        : null;
    }
    case '/organization/update-member-role': {
      const orgId = str(member.organizationId);
      const id = str(member.userId);
      // Setting the role a member already has changes nothing: no audit row.
      if (before.previousRole !== undefined && before.previousRole === member.role) return null;
      return orgId && id
        ? { action: 'member.role_changed', orgId, targetId: id, meta: { role: member.role } }
        : null;
    }
    case '/organization/remove-member': {
      const orgId = str(member.organizationId);
      const id = str(member.userId);
      return orgId && id ? { action: 'member.removed', orgId, targetId: id, meta: {} } : null;
    }
    case '/organization/leave': {
      const orgId = str(member.organizationId);
      const id = str(member.userId);
      return orgId && id ? { action: 'member.left', orgId, targetId: id, meta: {} } : null;
    }
    default:
      return null;
  }
}

/**
 * Before-hook: remembers what the after-hook needs to tell a role change from a no-op and a
 * resend from a new invitation.
 */
export async function rememberBeforeState(db: Db, ctx: HookContext): Promise<void> {
  if (ctx.path === '/organization/update-member-role') {
    const memberId = str(ctx.body?.memberId);
    if (!memberId) return;
    const [row] = await db
      .select({ role: memberTable.role })
      .from(memberTable)
      .where(eq(memberTable.id, memberId));
    beforeState.set(ctx.context, { previousRole: row?.role });
  } else if (ctx.path === '/organization/invite-member' && ctx.body?.resend === true) {
    const orgId = str(ctx.body.organizationId);
    const email = str(ctx.body.email)?.trim().toLowerCase();
    if (!orgId || !email) return;
    const [row] = await db
      .select({ id: invitationTable.id })
      .from(invitationTable)
      .where(
        and(
          eq(invitationTable.organizationId, orgId),
          eq(invitationTable.email, email),
          eq(invitationTable.status, 'pending'),
          gt(invitationTable.expiresAt, new Date()),
        ),
      );
    beforeState.set(ctx.context, { resend: row !== undefined });
  }
}

/**
 * After-hook: audits membership changes (any client: our pages, the API, server calls).
 *
 * Residual (P5-R30): better-auth has already committed the change when this runs, and the audit
 * row is not in its transaction (tying it in would mean leaving better-auth's endpoints). So a
 * failed audit write is retried once, then logged (`member_audit_failed`, error name and action
 * only) and the response still succeeds: the change exists, the audit row may be missing.
 * Not audited by design: `addMember` (server-only, no endpoint) and rejecting an invitation.
 */
export async function auditMembership(db: Db, ctx: HookContext): Promise<void> {
  const entry = ctx.path
    ? memberAuditEntry(ctx.path, ctx.context.returned, beforeState.get(ctx.context) ?? {})
    : null;
  if (!entry) return;
  const write = async () => {
    // The endpoint's session is not on the hook context: read it from the request again.
    const actorUserId = (await sessionOf(ctx))?.user.id ?? null;
    await withOrg(db, entry.orgId, (tx) =>
      recordAudit(tx, {
        orgId: entry.orgId,
        actorUserId,
        action: entry.action,
        targetType: entry.action.startsWith('member.invit') ? 'invitation' : 'user',
        targetId: entry.targetId,
        metadata: entry.meta as Record<string, unknown>,
      }),
    );
  };
  try {
    await write();
  } catch {
    try {
      await write();
    } catch (error) {
      console.error(
        `[auth] member_audit_failed ${error instanceof Error ? error.name : 'UnknownError'} ${entry.action}`,
      );
    }
  }
}

/** The workspace list-invitations acts on: the explicit id, else the active one. */
function orgIdOf(ctx: HookContext, session: { session: SessionLike }): string | null {
  // Exactly what the endpoint reads (query, else the active workspace), never the body.
  return str(ctx.query?.organizationId) || session.session.activeOrganizationId || null;
}

/**
 * Before-hook: only people who manage members list a workspace's invitations. An invitation id is
 * what accepting one needs, so viewers and managers never see them.
 */
export async function guardInvitationList(db: Db, ctx: HookContext): Promise<void> {
  if (ctx.path !== '/organization/list-invitations') return;
  const session = await sessionOf(ctx);
  const orgId = session ? orgIdOf(ctx, session) : null;
  const roles = session && orgId ? await getMemberRoles(db, orgId, session.user.id) : [];
  if (!can(roles, 'members.manage')) {
    throw new APIError('FORBIDDEN', {
      code: 'FORBIDDEN_ROLE',
      message: 'Only owners and admins see invitations.',
    });
  }
}

/**
 * After-hook: the full-organisation view (the browser's active workspace) carries no invitations
 * for people who do not manage members. Returns the replacement body, or null to keep it.
 */
export async function redactFullOrganization(
  db: Db,
  ctx: HookContext,
): Promise<Record<string, unknown> | null> {
  if (ctx.path !== '/organization/get-full-organization') return null;
  const returned = ctx.context.returned;
  if (!isRecord(returned) || !Array.isArray(returned.invitations)) return null;
  const userId = (await sessionOf(ctx))?.user.id;
  const orgId = str(returned.id);
  const roles = userId && orgId ? await getMemberRoles(db, orgId, userId) : [];
  return can(roles, 'members.manage') ? null : { ...returned, invitations: [] };
}

/**
 * After-hook: whatever list-invitations returns belongs to the workspace the guard checked.
 * Backstop in case the endpoint and the guard ever resolve the workspace differently.
 */
export async function checkInvitationListScope(db: Db, ctx: HookContext): Promise<void> {
  if (ctx.path !== '/organization/list-invitations') return;
  const returned = ctx.context.returned;
  if (!Array.isArray(returned) || returned.length === 0) return;
  const session = await sessionOf(ctx);
  const orgId = session ? orgIdOf(ctx, session) : null;
  const roles = session && orgId ? await getMemberRoles(db, orgId, session.user.id) : [];
  const ok =
    orgId !== null &&
    can(roles, 'members.manage') &&
    returned.every((i) => isRecord(i) && i.organizationId === orgId);
  if (!ok) {
    throw new APIError('FORBIDDEN', {
      code: 'FORBIDDEN_ROLE',
      message: 'Only owners and admins see invitations.',
    });
  }
}
