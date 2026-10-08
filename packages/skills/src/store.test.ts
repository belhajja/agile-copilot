import { randomUUID } from 'node:crypto';
import { type Actor, auditLog, createDb, deliveryChannels, skills, withOrg } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSkillSet } from './catalog';
import { serializeSkill } from './document';
import {
  copyBuiltinSkill,
  createSkill,
  deleteSkill,
  forkSkill,
  getSkill,
  getSkillVersion,
  listSkills,
  loadSkillsWithDocuments,
  setSkillEnabled,
  setSkillVisibility,
  updateSkill,
} from './store';

const NOW = new Date('2026-10-04T08:00:00Z');
const alice: Actor = { orgId: 'org_a', userId: 'user_alice', roles: ['viewer'] };
const bob: Actor = { orgId: 'org_a', userId: 'user_bob', roles: ['manager'] };
const admin: Actor = { orgId: 'org_a', userId: 'user_admin', roles: ['admin'] };
const outsider: Actor = { orgId: 'org_b', userId: 'user_eve', roles: ['owner'] };

const doc = (name: string, extra: Record<string, unknown> = {}, body = 'Summarise the sprint.') =>
  serializeSkill({
    frontmatter: { name, description: `About ${name}`, ...extra },
    instructions: body,
  });

const weekly = (output: string, name = 'weekly') =>
  doc(name, { trigger: 'schedule', schedule: { cron: '0 8 * * 1' }, output });

describe('skills store', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  let slack = '';

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    slack = randomUUID();
    await withOrg(app.db, 'org_a', (tx) =>
      tx.insert(deliveryChannels).values({
        id: slack,
        orgId: 'org_a',
        kind: 'slack',
        name: 'Team',
        hint: 'hooks.slack.com',
        secret: 's1.x.y.z',
        createdBy: 'user_admin',
      }),
    );
  });
  afterAll(async () => {
    await app?.close();
    await raw?.close();
    await tdb?.stop();
  });

  const create = async (actor: Actor, document: string, channelId?: string) => {
    const r = await createSkill(app.db, actor, { document, channelId, now: NOW });
    if (!r.ok) throw new Error(`create failed: ${r.code}`);
    return r.id;
  };

  it('creates a skill (version 1) that only its owner sees while private', async () => {
    const id = await create(alice, doc('sprint-digest'));
    expect((await listSkills(app.db, alice)).mine.map((s) => s.name)).toEqual(['sprint-digest']);
    expect((await listSkills(app.db, bob)).shared).toEqual([]);
    expect(await getSkill(app.db, bob, id)).toBeNull();
    expect(await getSkill(app.db, outsider, id)).toBeNull();
    const detail = await getSkill(app.db, alice, id);
    expect(detail).toMatchObject({
      skill: {
        name: 'sprint-digest',
        trigger: 'on_demand',
        output: 'chat',
        currentVersion: 1,
        enabled: true,
      },
      canEdit: true,
      canDelete: true,
    });
    expect(detail?.document).toContain('Summarise the sprint.');
    expect(detail?.versions.map((v) => v.version)).toEqual([1]);
    expect(await getSkill(app.db, alice, 'not-a-uuid')).toBeNull();
  });

  it('refuses invalid documents with issue codes, and duplicate names per owner', async () => {
    expect(await createSkill(app.db, alice, { document: '---\nname: x\n---\n', now: NOW })).toEqual(
      {
        ok: false,
        code: 'invalid',
        issues: [{ code: 'required', field: 'description' }, { code: 'empty_instructions' }],
      },
    );
    expect(await createSkill(app.db, alice, { document: doc('sprint-digest'), now: NOW })).toEqual({
      ok: false,
      code: 'duplicate_name',
    });
    // Another member may use the same name.
    expect((await createSkill(app.db, bob, { document: doc('sprint-digest'), now: NOW })).ok).toBe(
      true,
    );
  });

  it('requires a channel of the right kind for Slack/Teams outputs, and none otherwise', async () => {
    expect(await createSkill(app.db, admin, { document: weekly('slack'), now: NOW })).toEqual({
      ok: false,
      code: 'invalid_channel',
    });
    expect(
      await createSkill(app.db, admin, { document: weekly('teams'), channelId: slack, now: NOW }),
    ).toEqual({ ok: false, code: 'invalid_channel' });
    expect(
      await createSkill(app.db, admin, { document: weekly('email'), channelId: slack, now: NOW }),
    ).toEqual({ ok: false, code: 'invalid_channel' });
    expect(
      await createSkill(app.db, admin, {
        document: weekly('slack'),
        channelId: 'not-a-uuid',
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'invalid_channel' });
    // Another workspace's channel id is unknown here.
    expect(
      await createSkill(app.db, outsider, {
        document: weekly('slack'),
        channelId: slack,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'invalid_channel' });
    expect(
      (await createSkill(app.db, admin, { document: weekly('slack'), channelId: slack, now: NOW }))
        .ok,
    ).toBe(true);
  });

  it('keeps Slack/Teams outputs for owners and admins (P4-R4): managers and viewers get forbidden_output', async () => {
    for (const actor of [alice, bob]) {
      expect(
        await createSkill(app.db, actor, { document: weekly('slack'), channelId: slack, now: NOW }),
      ).toEqual({ ok: false, code: 'forbidden_output' });
    }
    expect(await createSkill(app.db, alice, { document: weekly('teams'), now: NOW })).toEqual({
      ok: false,
      code: 'forbidden_output',
    });
    // Saving a member's existing skill with a Slack output is refused too, and nothing changes.
    const id = await create(alice, weekly('email', 'member-weekly'));
    expect(
      await updateSkill(app.db, alice, id, {
        document: weekly('slack', 'member-weekly'),
        channelId: slack,
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'forbidden_output' });
    expect((await getSkill(app.db, alice, id))?.skill).toMatchObject({
      output: 'email',
      channelId: null,
      currentVersion: 1,
    });
    // A member cannot take over an admin's Slack skill by copying it.
    const adminSlack = await create(admin, weekly('slack', 'admin-slack'), slack);
    expect(await setSkillVisibility(app.db, admin, adminSlack, 'workspace')).toEqual({ ok: true });
    expect(await forkSkill(app.db, alice, adminSlack, NOW)).toEqual({
      ok: false,
      code: 'forbidden_output',
    });
    // Workspace owners may (outsider is an owner of org_b; no channel there, so the kind check runs).
    expect(await createSkill(app.db, outsider, { document: weekly('slack'), now: NOW })).toEqual({
      ok: false,
      code: 'invalid_channel',
    });
  });

  it('saves new versions from the version the editor loaded, never over a newer one', async () => {
    const id = await create(alice, doc('retro'));
    const later = new Date('2026-10-05T00:00:00Z');
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc('retro', {}, 'Version two.'),
        baseVersion: 1,
        now: later,
      }),
    ).toEqual({ ok: true, version: 2 });
    // A second tab still on version 1.
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc('retro', {}, 'Stale tab.'),
        baseVersion: 1,
        now: later,
      }),
    ).toEqual({ ok: false, code: 'version_conflict' });
    expect(await getSkillVersion(app.db, alice, id, 1)).toContain('Summarise the sprint.');
    expect(await getSkillVersion(app.db, alice, id, 2)).toContain('Version two.');
    expect(await getSkillVersion(app.db, bob, id, 1)).toBeNull();
    const detail = await getSkill(app.db, alice, id);
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail?.document).toContain('Version two.');
    expect(detail?.document).not.toContain('Stale tab.');
  });

  it('restarts the schedule from the save time when the schedule changes', async () => {
    const id = await create(
      alice,
      doc('mondays', { trigger: 'schedule', schedule: { cron: '0 8 * * 1' } }),
    );
    const cursor = async () =>
      (await raw.db.select({ c: skills.scheduleCursor }).from(skills).where(eq(skills.id, id)))[0]
        ?.c;
    expect(await cursor()).toEqual(NOW);
    const later = new Date('2026-10-06T00:00:00Z');
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc(
          'mondays',
          { trigger: 'schedule', schedule: { cron: '0 8 * * 1' } },
          'New text.',
        ),
        baseVersion: 1,
        now: later,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(await cursor()).toEqual(NOW); // same schedule: unchanged
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc('mondays', { trigger: 'schedule', schedule: { cron: '0 9 * * 1' } }),
        baseVersion: 2,
        now: later,
      }),
    ).toEqual({ ok: true, version: 3 });
    expect(await cursor()).toEqual(later);
  });

  it('forgets the boards an alert matched when its condition changes', async () => {
    const wip = (value: number, body = 'WIP is high.') =>
      doc('wip-alert', { trigger: 'alert', alert: { metric: 'wip', op: '>', value } }, body);
    const id = await create(alice, wip(10));
    const fired = new Date('2026-10-04T09:00:00Z');
    const board = randomUUID();
    await raw.db
      .update(skills)
      .set({ alertBoards: [board], alertFiredAt: fired })
      .where(eq(skills.id, id));
    const state = async () =>
      (
        await raw.db
          .select({ boards: skills.alertBoards, firedAt: skills.alertFiredAt })
          .from(skills)
          .where(eq(skills.id, id))
      )[0];
    expect(
      await updateSkill(app.db, alice, id, {
        document: wip(10, 'Reworded.'),
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(await state()).toEqual({ boards: [board], firedAt: fired }); // same condition: kept
    expect(
      await updateSkill(app.db, alice, id, { document: wip(12), baseVersion: 2, now: NOW }),
    ).toEqual({ ok: true, version: 3 });
    expect(await state()).toEqual({ boards: [], firedAt: null });
  });

  it('lets only the owner edit, share, enable or disable; others get forbidden or not found', async () => {
    const id = await create(alice, doc('owner-only'));
    const update = (actor: Actor) =>
      updateSkill(app.db, actor, id, { document: doc('owner-only'), baseVersion: 1, now: NOW });
    expect(await update(bob)).toEqual({ ok: false, code: 'not_found' }); // private: invisible
    expect(await setSkillVisibility(app.db, alice, id, 'workspace')).toEqual({ ok: true });
    expect(await update(bob)).toEqual({ ok: false, code: 'forbidden' });
    expect(await update(admin)).toEqual({ ok: false, code: 'forbidden' });
    expect(await setSkillVisibility(app.db, bob, id, 'private')).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await setSkillEnabled(app.db, bob, id, false, NOW)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await update(outsider)).toEqual({ ok: false, code: 'not_found' });
    expect((await listSkills(app.db, bob)).shared.map((s) => s.name)).toContain('owner-only');
    expect(await getSkill(app.db, bob, id)).toMatchObject({ canEdit: false, canDelete: false });
    expect(await getSkill(app.db, admin, id)).toMatchObject({ canEdit: false, canDelete: true });
  });

  it('forks a shared skill into a private, disabled snapshot under a free name', async () => {
    const id = await create(alice, doc('standup'));
    expect(await setSkillVisibility(app.db, alice, id, 'workspace')).toEqual({ ok: true });
    await create(bob, doc('standup', {}, "Bob's own."));
    const fork = await forkSkill(app.db, bob, id, NOW);
    if (!fork.ok) throw new Error(fork.code);
    const copy = await getSkill(app.db, bob, fork.id);
    expect(copy?.skill).toMatchObject({
      name: 'standup-copy',
      visibility: 'private',
      forkedFromId: id,
      ownerUserId: 'user_bob',
      // P4-R8: a copy of someone else's text starts off; its new owner turns it on.
      enabled: false,
    });
    expect(copy?.document).toContain('Summarise the sprint.');
    expect(copy?.document).toContain('name: standup-copy');
    // Later edits of the original do not reach the copy.
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc('standup', {}, 'Changed by Alice.'),
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect((await getSkill(app.db, bob, fork.id))?.document).not.toContain('Changed by Alice.');
    expect(await forkSkill(app.db, outsider, id, NOW)).toEqual({ ok: false, code: 'not_found' });
    const audit = await raw.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.targetId, fork.id));
    expect(audit).toEqual([{ action: 'skill.forked', actor: 'user_bob' }]);
  });

  it('refuses to record a fork of a skill the actor cannot read', async () => {
    const privateId = await create(alice, doc('alice-private'));
    expect(
      await createSkill(app.db, bob, {
        document: doc('sneaky'),
        forkedFrom: { id: privateId, version: 1 },
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'not_found' });
  });

  it("remembers the owner's language of the last save (wording of emails and posts)", async () => {
    const r = await createSkill(app.db, alice, {
      document: doc('in-french'),
      locale: 'fr',
      now: NOW,
    });
    if (!r.ok) throw new Error(r.code);
    const locale = async () =>
      (await raw.db.select({ l: skills.locale }).from(skills).where(eq(skills.id, r.id)))[0]?.l;
    expect(await locale()).toBe('fr');
    expect(
      await updateSkill(app.db, alice, r.id, {
        document: doc('in-french', {}, 'v2'),
        baseVersion: 1,
        locale: 'en',
        now: NOW,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(await locale()).toBe('en');
  });

  it('copies a built-in skill into an editable, enabled one', async () => {
    const r = await copyBuiltinSkill(app.db, bob, 'blocker-report', NOW);
    if (!r.ok) throw new Error(r.code);
    expect((await getSkill(app.db, bob, r.id))?.skill).toMatchObject({
      name: 'blocker-report',
      builtinKey: 'blocker-report',
      enabled: true,
    });
    expect(await copyBuiltinSkill(app.db, bob, 'nope', NOW)).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('lets the owner delete, and an admin delete a shared skill (moderation)', async () => {
    const privateId = await create(alice, doc('secret-notes'));
    expect(await deleteSkill(app.db, admin, privateId)).toEqual({ ok: false, code: 'not_found' });
    const sharedId = await create(alice, doc('shared-notes'));
    expect(await setSkillVisibility(app.db, alice, sharedId, 'workspace')).toEqual({ ok: true });
    // Moderation is for owners and admins: neither a manager nor a viewer removes others' skills.
    const viewerCarol: Actor = { orgId: 'org_a', userId: 'user_carol2', roles: ['viewer'] };
    for (const actor of [bob, viewerCarol]) {
      expect(await deleteSkill(app.db, actor, sharedId)).toEqual({ ok: false, code: 'forbidden' });
    }
    expect(await deleteSkill(app.db, admin, sharedId)).toEqual({ ok: true });
    expect(await deleteSkill(app.db, alice, privateId)).toEqual({ ok: true });
    expect(await getSkill(app.db, alice, privateId)).toBeNull();
    const actions = await raw.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.action, 'skill.deleted'))
      .orderBy(asc(auditLog.createdAt));
    expect(actions).toEqual([
      { action: 'skill.deleted', actor: 'user_admin', target: sharedId },
      { action: 'skill.deleted', actor: 'user_alice', target: privateId },
    ]);
  });

  it('loads skills with their current parsed document in one joined query', async () => {
    const dave: Actor = { orgId: 'org_a', userId: 'user_dave', roles: ['viewer'] };
    const a = await create(dave, doc('dave-a'));
    expect(
      await updateSkill(app.db, dave, a, {
        document: doc('dave-a', {}, 'Second version.'),
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true, version: 2 });
    await create(dave, doc('dave-b'));
    const loaded = await withOrg(app.db, 'org_a', (tx) =>
      loadSkillsWithDocuments(tx, eq(skills.ownerUserId, 'user_dave')),
    );
    expect(loaded.map((l) => [l.skill.name, l.skill.currentVersion])).toEqual([
      ['dave-a', 2],
      ['dave-b', 1],
    ]);
    expect(loaded[0]?.document).toContain('Second version.');
    expect(loaded[0]?.parsed).toMatchObject({
      ok: true,
      skill: { instructions: 'Second version.' },
    });
    // RLS: another workspace sees none of them.
    expect(
      await withOrg(app.db, 'org_b', (tx) =>
        loadSkillsWithDocuments(tx, eq(skills.ownerUserId, 'user_dave')),
      ),
    ).toEqual([]);
  });

  it("builds the assistant's skill set: own skills, preferences, built-ins not copied", async () => {
    const carol: Actor = { orgId: 'org_a', userId: 'user_carol', roles: ['viewer'] };
    await create(carol, doc('french', { trigger: 'always' }, 'Answer in French.'));
    const off = await create(carol, doc('disabled-one'));
    expect(await setSkillEnabled(app.db, carol, off, false, NOW)).toEqual({ ok: true });
    expect((await copyBuiltinSkill(app.db, carol, 'retro-prep', NOW)).ok).toBe(true);
    // Shared by someone else: not in Carol's set until she copies it.
    const shared = await create(alice, doc('alice-shared'));
    expect(await setSkillVisibility(app.db, alice, shared, 'workspace')).toEqual({ ok: true });

    const set = await loadSkillSet(app.db, carol);
    expect(set.preferences).toEqual([{ name: 'french', instructions: 'Answer in French.' }]);
    const names = set.catalog.map((c) => `${c.source}:${c.name}`);
    expect(names).toContain('own:retro-prep');
    expect(names).not.toContain('builtin:retro-prep');
    expect(names).toContain('builtin:sprint-health-check');
    expect(names.some((n) => n.endsWith(':french'))).toBe(false);
    expect(names.some((n) => n.endsWith(':disabled-one'))).toBe(false);
    expect(names.some((n) => n.endsWith(':alice-shared'))).toBe(false);
    expect(set.instructions.get('sprint-health-check')).toMatch(/current sprint/);

    // Copying the shared skill starts disabled (P4-R8): still absent until Carol turns it on.
    const fork = await forkSkill(app.db, carol, shared, NOW);
    if (!fork.ok) throw new Error(fork.code);
    expect((await loadSkillSet(app.db, carol)).catalog.map((c) => c.name)).not.toContain(
      'alice-shared',
    );
    expect(await setSkillEnabled(app.db, carol, fork.id, true, NOW)).toEqual({ ok: true });
    expect((await loadSkillSet(app.db, carol)).catalog).toContainEqual({
      name: 'alice-shared',
      description: 'About alice-shared',
      source: 'own',
    });
  });

  it('sets builtinKey only for a real built-in (unknown keys are refused)', async () => {
    expect(
      await createSkill(app.db, alice, {
        document: doc('fake-builtin'),
        builtinKey: 'nope',
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect((await listSkills(app.db, alice)).mine.map((s) => s.name)).not.toContain('fake-builtin');
  });

  it('keeps the stock built-in hidden while the user has any copy of it, even a disabled one', async () => {
    const frank: Actor = { orgId: 'org_a', userId: 'user_frank', roles: ['viewer'] };
    const r = await copyBuiltinSkill(app.db, frank, 'blocker-report', NOW);
    if (!r.ok) throw new Error(r.code);
    expect(await setSkillEnabled(app.db, frank, r.id, false, NOW)).toEqual({ ok: true });
    const names = (await loadSkillSet(app.db, frank)).catalog.map((c) => `${c.source}:${c.name}`);
    expect(names).not.toContain('builtin:blocker-report');
    expect(names).not.toContain('own:blocker-report');
    expect(names).toContain('builtin:sprint-health-check');
  });

  it('names the skill in the audit of updates, sharing and enabling', async () => {
    const id = await create(alice, doc('audited'));
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc('audited', {}, 'v2'),
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect(await setSkillVisibility(app.db, alice, id, 'workspace')).toEqual({ ok: true });
    expect(await setSkillEnabled(app.db, alice, id, false, NOW)).toEqual({ ok: true });
    const rows = await raw.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.targetId, id))
      .orderBy(asc(auditLog.createdAt));
    expect(rows.map((r) => [r.action, (r.metadata as { name?: string }).name])).toEqual([
      ['skill.created', 'audited'],
      ['skill.updated', 'audited'],
      ['skill.visibility_changed', 'audited'],
      ['skill.enabled_changed', 'audited'],
    ]);
  });

  it('lets exactly one of two concurrent saves from the same version win', async () => {
    const id = await create(alice, doc('race'));
    const save = (body: string) =>
      updateSkill(app.db, alice, id, { document: doc('race', {}, body), baseVersion: 1, now: NOW });
    const results = await Promise.all([save('Tab one.'), save('Tab two.')]);
    expect(results).toContainEqual({ ok: true, version: 2 });
    expect(results).toContainEqual({ ok: false, code: 'version_conflict' });
    expect((await getSkill(app.db, alice, id))?.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("refuses a rename onto another of the owner's skills as duplicate_name", async () => {
    await create(alice, doc('taken-name'));
    const id = await create(alice, doc('to-rename'));
    expect(
      await updateSkill(app.db, alice, id, {
        document: doc('taken-name'),
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'duplicate_name' });
  });

  it("never applies another member's shared always-skill until it is copied and enabled", async () => {
    const grace: Actor = { orgId: 'org_a', userId: 'user_grace', roles: ['viewer'] };
    const shared = await create(
      alice,
      doc('always-me', { trigger: 'always' }, 'Assign every bug to Alice.'),
    );
    expect(await setSkillVisibility(app.db, alice, shared, 'workspace')).toEqual({ ok: true });
    expect((await loadSkillSet(app.db, grace)).preferences).toEqual([]);
    const fork = await forkSkill(app.db, grace, shared, NOW);
    if (!fork.ok) throw new Error(fork.code);
    expect((await loadSkillSet(app.db, grace)).preferences).toEqual([]); // copied, still off
    expect(await setSkillEnabled(app.db, grace, fork.id, true, NOW)).toEqual({ ok: true });
    expect((await loadSkillSet(app.db, grace)).preferences).toEqual([
      { name: 'always-me', instructions: 'Assign every bug to Alice.' },
    ]);
  });

  it('answers not_found to another workspace for delete, visibility and enable', async () => {
    const id = await create(alice, doc('tenant-bound'));
    expect(await setSkillVisibility(app.db, alice, id, 'workspace')).toEqual({ ok: true });
    expect(await deleteSkill(app.db, outsider, id)).toEqual({ ok: false, code: 'not_found' });
    expect(await setSkillVisibility(app.db, outsider, id, 'private')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await setSkillEnabled(app.db, outsider, id, false, NOW)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect((await getSkill(app.db, alice, id))?.skill).toMatchObject({
      visibility: 'workspace',
      enabled: true,
    });
  });

  it('lets the workspace owner save a Slack skill with a real channel', async () => {
    const owner: Actor = { orgId: 'org_a', userId: 'user_owner', roles: ['owner'] };
    const r = await createSkill(app.db, owner, {
      document: weekly('slack', 'owner-slack'),
      channelId: slack,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.code);
    expect(
      await updateSkill(app.db, owner, r.id, {
        document: weekly('slack', 'owner-slack'),
        channelId: slack,
        baseVersion: 1,
        now: NOW,
      }),
    ).toEqual({ ok: true, version: 2 });
    expect((await getSkill(app.db, owner, r.id))?.skill).toMatchObject({
      output: 'slack',
      channelId: slack,
    });
  });
});
