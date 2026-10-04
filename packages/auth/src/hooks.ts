import { type AuditAction, type Db, recordAudit, withOrg } from '@agile/db';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { can, getMemberRoles } from './roles';

/** What the auth middleware sees of an endpoint call (the fields we read). */
export interface HookContext {
  path?: string;
  body?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  context: { returned?: unknown };
}
interface SessionLike {
  activeOrganizationId?: string | null;
  [key: string]: unknown;
}

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
): { action: MemberAuditAction; orgId: string; targetId: string; meta: object } | null {
  if (!isRecord(returned)) return null;
  const member = isRecord(returned.member) ? returned.member : returned;
  const invitation = isRecord(returned.invitation) ? returned.invitation : returned;
  switch (path) {
    case '/organization/invite-member': {
      const orgId = str(invitation.organizationId);
      const id = str(invitation.id);
      return orgId && id
        ? { action: 'member.invited', orgId, targetId: id, meta: { role: invitation.role } }
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

/** After-hook: audits membership changes (any client: our pages, the API, server calls). */
export async function auditMembership(db: Db, ctx: HookContext): Promise<void> {
  const entry = ctx.path ? memberAuditEntry(ctx.path, ctx.context.returned) : null;
  if (!entry) return;
  // The endpoint's session is not on the hook context: read it from the request again.
  const actorUserId = (await getSessionFromCtx(ctx as never))?.user.id ?? null;
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
}

/** The workspace an organisation endpoint acts on: the explicit id, else the active one. */
function orgIdOf(ctx: HookContext, session: { session: SessionLike }): string | null {
  return (
    str(ctx.query?.organizationId) ??
    str(ctx.body?.organizationId) ??
    session.session.activeOrganizationId ??
    null
  );
}

/**
 * Before-hook: only people who manage members list a workspace's invitations. An invitation id is
 * what accepting one needs, so viewers and managers never see them.
 */
export async function guardInvitationList(db: Db, ctx: HookContext): Promise<void> {
  if (ctx.path !== '/organization/list-invitations') return;
  const session = await getSessionFromCtx(ctx as never);
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
  const userId = (await getSessionFromCtx(ctx as never))?.user.id;
  const orgId = str(returned.id);
  const roles = userId && orgId ? await getMemberRoles(db, orgId, userId) : [];
  return can(roles, 'members.manage') ? null : { ...returned, invitations: [] };
}
