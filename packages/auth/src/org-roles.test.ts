import { createDb, invitation, member as memberTable, organization } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Auth, createAuth } from './server';

const cookieHeader = (h: Headers) =>
  new Headers({
    cookie: h
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

/** Roles that are not exactly one of the four; each would slip past an untrimmed owner check. */
const NOT_EXACT = [' owner', 'owner ', ' admin', 'owner,admin', 'viewer, owner'];

/**
 * better-auth's own member, invitation and workspace endpoints, as our roles see them. These are
 * what a browser can call directly, whatever our pages show.
 */
describe('organisation endpoints under the four roles', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let auth: Auth;
  let organizationId: string;
  const h: Record<'owner' | 'admin' | 'manager' | 'viewer', Headers> = {} as never;
  const ids: Record<'owner' | 'admin' | 'manager' | 'viewer', string> = {} as never;
  let pendingInvitationId: string;

  const signUp = async (email: string) =>
    cookieHeader(
      (
        await auth.api.signUpEmail({
          body: { email, password: 'correct-horse-1', name: 'n' },
          returnHeaders: true,
        })
      ).headers,
    );
  const roleOf = async (memberId: string) =>
    (await conn.db.select().from(memberTable).where(eq(memberTable.id, memberId)))[0]?.role;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 2 });
    auth = createAuth({ db: conn.db, secret: 'x'.repeat(32), baseURL: 'http://localhost:3000' });
    h.owner = await signUp('owner@example.com');
    const org = await auth.api.createOrganization({
      headers: h.owner,
      body: { name: 'Org', slug: 'org' },
    });
    organizationId = org?.id ?? '';
    for (const role of ['admin', 'manager', 'viewer'] as const) {
      const inv = await auth.api.createInvitation({
        headers: h.owner,
        body: { email: `${role}@example.com`, role: role as 'admin', organizationId },
      });
      h[role] = await signUp(`${role}@example.com`);
      await auth.api.acceptInvitation({ headers: h[role], body: { invitationId: inv?.id ?? '' } });
    }
    const members = await conn.db
      .select()
      .from(memberTable)
      .where(eq(memberTable.organizationId, organizationId));
    for (const m of members) ids[m.role as keyof typeof ids] = m.id;
    const pending = await auth.api.createInvitation({
      headers: h.owner,
      body: { email: 'pending@example.com', role: 'viewer' as 'admin', organizationId },
    });
    pendingInvitationId = pending?.id ?? '';
  });
  afterAll(async () => {
    await conn?.close();
    await tdb?.stop();
  });

  it('starts with one member per role', () => {
    expect(Object.keys(ids).sort()).toEqual(['admin', 'manager', 'owner', 'viewer']);
  });

  it('refuses invitations whose role is not exactly one of the four', async () => {
    for (const inviter of ['owner', 'admin'] as const) {
      for (const role of NOT_EXACT) {
        await expect(
          auth.api.createInvitation({
            headers: h[inviter],
            body: { email: 'new@example.com', role: role as 'admin', organizationId },
          }),
        ).rejects.toMatchObject({ body: { code: 'ROLE_NOT_ALLOWED' } });
      }
      await expect(
        auth.api.createInvitation({
          headers: h[inviter],
          body: { email: 'new@example.com', role: ['viewer', ' owner'] as never, organizationId },
        }),
      ).rejects.toMatchObject({ body: { code: 'ROLE_NOT_ALLOWED' } });
    }
    const rows = await conn.db
      .select()
      .from(invitation)
      .where(eq(invitation.email, 'new@example.com'));
    expect(rows).toEqual([]);
  });

  it('refuses role changes that are not exactly one of the four', async () => {
    for (const updater of ['owner', 'admin'] as const) {
      for (const role of NOT_EXACT) {
        await expect(
          auth.api.updateMemberRole({
            headers: h[updater],
            body: { memberId: ids.viewer, role: role as 'admin', organizationId },
          }),
        ).rejects.toMatchObject({ statusCode: expect.any(Number) });
        expect(await roleOf(ids.viewer)).toBe('viewer');
      }
    }
    // Refused by our check, before better-auth trims it.
    await expect(
      auth.api.updateMemberRole({
        headers: h.owner,
        body: { memberId: ids.viewer, role: ' admin' as 'admin', organizationId },
      }),
    ).rejects.toMatchObject({ body: { code: 'ROLE_NOT_ALLOWED' } });
  });

  it('refuses a server-side add with a role that is not exactly one of the four', async () => {
    const extraH = await signUp('extra@example.com');
    const extra = await auth.api.getSession({ headers: extraH });
    for (const role of [...NOT_EXACT, 'member']) {
      await expect(
        auth.api.addMember({
          body: { userId: extra?.user.id ?? '', role: role as 'admin', organizationId },
        }),
      ).rejects.toMatchObject({ body: { code: 'ROLE_NOT_ALLOWED' } });
    }
  });

  it('an admin cannot invite, promote to or remove an owner', async () => {
    await expect(
      auth.api.createInvitation({
        headers: h.admin,
        body: { email: 'boss2@example.com', role: 'owner', organizationId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      auth.api.updateMemberRole({
        headers: h.admin,
        body: { memberId: ids.viewer, role: 'owner', organizationId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      auth.api.updateMemberRole({
        headers: h.admin,
        body: { memberId: ids.owner, role: 'viewer' as 'admin', organizationId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      auth.api.removeMember({
        headers: h.admin,
        body: { memberIdOrEmail: ids.owner, organizationId },
      }),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect(await roleOf(ids.owner)).toBe('owner');
    expect(await roleOf(ids.viewer)).toBe('viewer');
  });

  it('managers and viewers manage nobody and cannot change the workspace', async () => {
    for (const who of ['manager', 'viewer'] as const) {
      const attempts: [string, () => Promise<unknown>][] = [
        [
          'invite',
          () =>
            auth.api.createInvitation({
              headers: h[who],
              body: { email: 'z@example.com', role: 'viewer' as 'admin', organizationId },
            }),
        ],
        [
          'demote the admin',
          () =>
            auth.api.updateMemberRole({
              headers: h[who],
              body: { memberId: ids.admin, role: 'viewer' as 'admin', organizationId },
            }),
        ],
        [
          'promote self',
          () =>
            auth.api.updateMemberRole({
              headers: h[who],
              body: { memberId: ids[who], role: 'admin', organizationId },
            }),
        ],
        [
          'remove the admin',
          () =>
            auth.api.removeMember({
              headers: h[who],
              body: { memberIdOrEmail: ids.admin, organizationId },
            }),
        ],
        [
          'cancel an invitation',
          () =>
            auth.api.cancelInvitation({
              headers: h[who],
              body: { invitationId: pendingInvitationId },
            }),
        ],
        [
          'rename the workspace',
          () =>
            auth.api.updateOrganization({
              headers: h[who],
              body: { data: { name: 'pwned' }, organizationId },
            }),
        ],
        [
          'delete the workspace',
          () => auth.api.deleteOrganization({ headers: h[who], body: { organizationId } }),
        ],
      ];
      for (const [what, attempt] of attempts) {
        // better-auth answers 403, or 401 for a member removal.
        const outcome = await attempt().then(
          () => 'allowed',
          (e: { statusCode?: number }) =>
            e.statusCode === 401 || e.statusCode === 403 ? 'refused' : e.statusCode,
        );
        expect({ who, what, outcome }).toEqual({ who, what, outcome: 'refused' });
      }
    }
    expect(await roleOf(ids.admin)).toBe('admin');
    expect(await roleOf(ids.manager)).toBe('manager');
    expect(await roleOf(ids.viewer)).toBe('viewer');
    const [org] = await conn.db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId));
    expect(org?.name).toBe('Org');
    const [pending] = await conn.db
      .select()
      .from(invitation)
      .where(eq(invitation.id, pendingInvitationId));
    expect(pending?.status).toBe('pending');
  });
});
