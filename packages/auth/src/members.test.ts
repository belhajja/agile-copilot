import { auditLog, createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listInvitationsForEmail,
  listPendingInvitations,
  listWorkspaceMembers,
  seatsInUse,
} from './members';
import { type Auth, createAuth } from './server';

const cookieHeader = (h: Headers) =>
  new Headers({
    cookie: h
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

describe('workspace membership: audit and invitation privacy', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  let auth: Auth;
  let orgId = '';
  let ownerH: Headers;
  let ownerId = '';
  let viewerH: Headers;
  let viewerId = '';

  const signUp = async (email: string) => {
    const { headers, response } = await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-1', name: email.split('@')[0] ?? 'x' },
      returnHeaders: true,
    });
    return { h: cookieHeader(headers), id: response.user.id };
  };
  const auditRows = () =>
    raw.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId))
      .orderBy(asc(auditLog.createdAt));

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    auth = createAuth({ db: conn.db, secret: 'x'.repeat(32), baseURL: 'http://localhost:3000' });
    const o = await signUp('owner@example.com');
    ownerH = o.h;
    ownerId = o.id;
    const org = await auth.api.createOrganization({
      headers: ownerH,
      body: { name: 'Members', slug: 'members' },
    });
    orgId = org?.id ?? '';
    const v = await signUp('viewer@example.com');
    viewerH = v.h;
    viewerId = v.id;
  });
  afterAll(async () => {
    await conn?.close();
    await raw?.close();
    await tdb?.stop();
  });

  it('audits invitations, joins, role changes and removals with the acting user', async () => {
    const inv = await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'viewer@example.com', role: 'viewer' as 'admin', organizationId: orgId },
    });
    await auth.api.acceptInvitation({ headers: viewerH, body: { invitationId: inv?.id ?? '' } });
    const [m] = (await listWorkspaceMembers(conn.db, orgId)).filter((x) => x.userId === viewerId);
    await auth.api.updateMemberRole({
      headers: ownerH,
      body: { memberId: m?.memberId ?? '', role: 'manager' as 'admin', organizationId: orgId },
    });
    await auth.api.updateMemberRole({
      headers: ownerH,
      body: { memberId: m?.memberId ?? '', role: 'viewer' as 'admin', organizationId: orgId },
    });
    const other = await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'later@example.com', role: 'manager' as 'admin', organizationId: orgId },
    });
    await auth.api.cancelInvitation({ headers: ownerH, body: { invitationId: other?.id ?? '' } });

    const rows = (await auditRows()).map((r) => ({
      action: r.action,
      actor: r.actorUserId,
      target: r.targetId,
      metadata: r.metadata,
    }));
    expect(rows).toEqual([
      { action: 'member.invited', actor: ownerId, target: inv?.id, metadata: { role: 'viewer' } },
      {
        action: 'member.joined',
        actor: viewerId,
        target: viewerId,
        metadata: { role: 'viewer', invitationId: inv?.id },
      },
      {
        action: 'member.role_changed',
        actor: ownerId,
        target: viewerId,
        metadata: { role: 'manager' },
      },
      {
        action: 'member.role_changed',
        actor: ownerId,
        target: viewerId,
        metadata: { role: 'viewer' },
      },
      {
        action: 'member.invited',
        actor: ownerId,
        target: other?.id,
        metadata: { role: 'manager' },
      },
      { action: 'member.invitation_cancelled', actor: ownerId, target: other?.id, metadata: {} },
    ]);
    // No email address in the audit trail.
    expect(JSON.stringify(rows)).not.toContain('@example.com');
  });

  it('shows invitations to owners and admins only', async () => {
    await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'pending@example.com', role: 'admin', organizationId: orgId },
    });
    await auth.api.setActiveOrganization({ headers: viewerH, body: { organizationId: orgId } });

    await expect(
      auth.api.listInvitations({ headers: viewerH, query: { organizationId: orgId } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await auth.api.listInvitations({ headers: ownerH, query: { organizationId: orgId } }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'pending@example.com' })]));

    // The browser's active-workspace view: the viewer gets the members, not the invitations.
    const seenByViewer = await auth.api.getFullOrganization({
      headers: viewerH,
      query: { organizationId: orgId },
    });
    expect(seenByViewer?.members.length).toBe(2);
    expect(seenByViewer?.invitations).toEqual([]);
    const seenByOwner = await auth.api.getFullOrganization({
      headers: ownerH,
      query: { organizationId: orgId },
    });
    expect(seenByOwner?.invitations.map((i) => i.email)).toContain('pending@example.com');
  });

  it('lists members, pending invitations and seats from the database', async () => {
    const members = await listWorkspaceMembers(conn.db, orgId);
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ['owner@example.com', 'owner'],
      ['viewer@example.com', 'viewer'],
    ]);
    const pending = await listPendingInvitations(conn.db, orgId);
    expect(pending.map((p) => [p.email, p.role])).toEqual([['pending@example.com', 'admin']]);
    expect(await seatsInUse(conn.db, orgId)).toBe(3);
    // What the invitee's onboarding page lists (any letter case of the address).
    expect(await listInvitationsForEmail(conn.db, 'Pending@Example.com')).toEqual([
      expect.objectContaining({ organizationName: 'Members', role: 'admin' }),
    ]);
    expect(await listInvitationsForEmail(conn.db, 'nobody@example.com')).toEqual([]);
    // Expired invitations hold no seat.
    expect(await seatsInUse(conn.db, orgId, new Date(Date.now() + 30 * 86_400_000))).toBe(2);
  });

  it('keeps invitations from managers too', async () => {
    const m = await signUp('manager@example.com');
    const inv = await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'manager@example.com', role: 'manager' as 'admin', organizationId: orgId },
    });
    await auth.api.acceptInvitation({ headers: m.h, body: { invitationId: inv?.id ?? '' } });
    await expect(
      auth.api.listInvitations({ headers: m.h, query: { organizationId: orgId } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const seen = await auth.api.getFullOrganization({
      headers: m.h,
      query: { organizationId: orgId },
    });
    expect(seen?.invitations).toEqual([]);
    // Neither does an outsider.
    const outsider = await signUp('outsider@example.com');
    await expect(
      auth.api.listInvitations({ headers: outsider.h, query: { organizationId: orgId } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('audits removals', async () => {
    await auth.api.removeMember({
      headers: ownerH,
      body: { memberIdOrEmail: 'viewer@example.com', organizationId: orgId },
    });
    const last = (await auditRows()).at(-1);
    expect(last).toMatchObject({
      action: 'member.removed',
      actorUserId: ownerId,
      targetId: viewerId,
    });
  });

  it('lets admins see invitations, in the endpoint and the full-organisation view', async () => {
    const a = await signUp('admin@example.com');
    const inv = await auth.api.createInvitation({
      headers: ownerH,
      body: { email: 'admin@example.com', role: 'admin', organizationId: orgId },
    });
    await auth.api.acceptInvitation({ headers: a.h, body: { invitationId: inv?.id ?? '' } });
    await auth.api.createInvitation({
      headers: ownerH,
      body: {
        email: 'seen-by-admin@example.com',
        role: 'viewer' as 'admin',
        organizationId: orgId,
      },
    });
    const listed = await auth.api.listInvitations({
      headers: a.h,
      query: { organizationId: orgId },
    });
    expect(listed.map((i) => i.email)).toContain('seen-by-admin@example.com');
    const full = await auth.api.getFullOrganization({
      headers: a.h,
      query: { organizationId: orgId },
    });
    expect(full?.invitations.map((i) => i.email)).toContain('seen-by-admin@example.com');
  });

  it('audits a resend as member.invite_resent and a same-role update not at all', async () => {
    const before = (await auditRows()).length;
    await auth.api.createInvitation({
      headers: ownerH,
      body: {
        email: 'seen-by-admin@example.com',
        role: 'viewer' as 'admin',
        organizationId: orgId,
        resend: true,
      },
    });
    const adminMember = (await listWorkspaceMembers(conn.db, orgId)).find(
      (m) => m.email === 'admin@example.com',
    );
    await auth.api.updateMemberRole({
      headers: ownerH,
      body: { memberId: adminMember?.memberId ?? '', role: 'admin', organizationId: orgId },
    });
    const added = (await auditRows()).slice(before);
    expect(added.map((r) => r.action)).toEqual(['member.invite_resent']);
    expect(added[0]?.actorUserId).toBe(ownerId);
  });

  it('audits leaving a workspace as member.left', async () => {
    const [mgr] = (await listWorkspaceMembers(conn.db, orgId)).filter(
      (m) => m.email === 'manager@example.com',
    );
    const managerH = (
      await auth.api.signInEmail({
        body: { email: 'manager@example.com', password: 'correct-horse-1' },
        returnHeaders: true,
      })
    ).headers;
    await auth.api.leaveOrganization({
      headers: cookieHeader(managerH),
      body: { organizationId: orgId },
    });
    expect(await auditRows().then((r) => r.at(-1))).toMatchObject({
      action: 'member.left',
      actorUserId: mgr?.userId,
      targetId: mgr?.userId,
    });
  });
});
