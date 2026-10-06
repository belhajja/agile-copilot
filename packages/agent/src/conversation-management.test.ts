import { randomUUID } from 'node:crypto';
import { agentConversations, createDb, llmConnections, withOrg } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import type { UIMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGroup,
  deleteGroup,
  listConversationHistory,
  MAX_GROUPS,
  moveConversationToGroup,
  renameGroup,
} from './conversation-groups';
import {
  beginTurn,
  conversationModelId,
  deleteConversation,
  loadConversation,
  openOrCreateConversation,
  renameConversation,
  saveConversation,
  setConversationArchived,
  setConversationModel,
} from './conversations';
import type { AgentActor } from './deps';

const alice: AgentActor = { orgId: 'org_a', userId: 'user_alice', roles: ['viewer'] };
const bob: AgentActor = { orgId: 'org_a', userId: 'user_bob', roles: ['owner'] };
const eve: AgentActor = { orgId: 'org_b', userId: 'user_eve', roles: ['owner'] };

const question = (text: string): UIMessage[] => [
  { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
];

describe('managing conversations (rename, archive, delete, model, groups) as app_user', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 4 });
    owner = createDb(tdb.ownerUrl, { max: 1 });
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.stop();
  });

  /** A conversation of `actor` with one question (so it has a title and shows in lists). */
  const started = async (actor: AgentActor, text = 'What is our velocity?') => {
    const id = randomUUID();
    await openOrCreateConversation(app.db, actor, id);
    await withOrg(app.db, actor.orgId, (tx) => saveConversation(tx, actor, id, question(text)));
    return id;
  };
  const updatedAtOf = async (id: string) =>
    (
      await owner.db
        .select({ at: agentConversations.updatedAt })
        .from(agentConversations)
        .where(eq(agentConversations.id, id))
    )[0]?.at.getTime();
  const llm = async (orgId: string, model: string) => {
    const id = randomUUID();
    await owner.db.insert(llmConnections).values({
      id,
      orgId,
      label: model,
      provider: 'anthropic',
      model,
      secret: 'x',
      createdBy: 'user_bob',
    });
    return id;
  };

  it('renames only the owner’s conversation, keeps its place by date, refuses blank titles', async () => {
    const id = await started(alice);
    const before = await updatedAtOf(id);
    expect(await renameConversation(app.db, alice, id, '  Sprint   77  review ')).toBe(true);
    expect((await loadConversation(app.db, alice, id))?.title).toBe('Sprint 77 review');
    expect(await updatedAtOf(id)).toBe(before);
    expect(await renameConversation(app.db, alice, id, '   ')).toBe(false);
    expect(await renameConversation(app.db, bob, id, 'Mine now')).toBe(false);
    expect(await renameConversation(app.db, eve, id, 'Mine now')).toBe(false);
    expect((await loadConversation(app.db, alice, id))?.title).toBe('Sprint 77 review');
    // A later answer does not overwrite a chosen title.
    await withOrg(app.db, 'org_a', (tx) =>
      saveConversation(tx, alice, id, question('Another question')),
    );
    expect((await loadConversation(app.db, alice, id))?.title).toBe('Sprint 77 review');
  });

  it('archives and brings back a conversation; archived ones leave the recent list', async () => {
    const id = await started(alice, 'Archive me');
    expect(await setConversationArchived(app.db, bob, id, true)).toBe(false);
    expect(await setConversationArchived(app.db, alice, id, true)).toBe(true);
    let history = await listConversationHistory(app.db, alice);
    expect(history.recent.map((c) => c.id)).not.toContain(id);
    expect(history.archived.map((c) => c.id)).toContain(id);
    expect((await loadConversation(app.db, alice, id))?.archived).toBe(true);
    expect(await setConversationArchived(app.db, alice, id, false)).toBe(true);
    history = await listConversationHistory(app.db, alice);
    expect(history.recent.map((c) => c.id)).toContain(id);
    expect(history.archived.map((c) => c.id)).not.toContain(id);
  });

  it('deletes only the owner’s conversation, and never while a reply is being written', async () => {
    const id = await started(alice, 'Delete me');
    expect(await deleteConversation(app.db, bob, id)).toBe('not_found');
    expect(await deleteConversation(app.db, eve, id)).toBe('not_found');
    await withOrg(app.db, 'org_a', (tx) => beginTurn(tx, alice, id, randomUUID()));
    expect(await deleteConversation(app.db, alice, id)).toBe('turn_in_progress');
    await owner.db
      .update(agentConversations)
      .set({ turnId: null, turnStartedAt: null })
      .where(eq(agentConversations.id, id));
    expect(await deleteConversation(app.db, alice, id)).toBe('deleted');
    expect(await loadConversation(app.db, alice, id)).toBeNull();
    expect(await deleteConversation(app.db, alice, id)).toBe('not_found');
  });

  it('picks a model among the workspace’s connections, creating a new conversation', async () => {
    const mine = await llm('org_a', 'qwen');
    const theirs = await llm('org_b', 'other-workspace-model');
    const id = randomUUID();
    expect(await setConversationModel(app.db, alice, id, mine)).toBe('ok');
    expect(await conversationModelId(app.db, alice, id)).toBe(mine);
    // Created but untitled: not listed until the first question.
    expect((await listConversationHistory(app.db, alice)).recent.map((c) => c.id)).not.toContain(
      id,
    );
    expect(await setConversationModel(app.db, alice, id, theirs)).toBe('unknown_model');
    expect(await setConversationModel(app.db, alice, id, 'not-a-uuid')).toBe('unknown_model');
    expect(await setConversationModel(app.db, bob, id, mine)).toBe('not_found');
    expect(await conversationModelId(app.db, bob, id)).toBeNull();
    expect(await setConversationModel(app.db, alice, id, null)).toBe('ok');
    expect(await conversationModelId(app.db, alice, id)).toBeNull();
    // Deleting the connection sends the conversation back to the default.
    await setConversationModel(app.db, alice, id, mine);
    await owner.db.delete(llmConnections).where(eq(llmConnections.id, mine));
    expect(await conversationModelId(app.db, alice, id)).toBeNull();
  });

  it('files conversations in the owner’s groups only; deleting a group ungroups them', async () => {
    const id = await started(alice, 'Velocity of AIA');
    const created = await createGroup(app.db, alice, '  Sprint 77 ');
    if (!created.ok) throw new Error(created.code);
    const bobs = await createGroup(app.db, bob, 'Bob’s');
    if (!bobs.ok) throw new Error(bobs.code);
    expect(await moveConversationToGroup(app.db, alice, id, bobs.id)).toBe(false);
    expect(await moveConversationToGroup(app.db, bob, id, bobs.id)).toBe(false);
    expect(await moveConversationToGroup(app.db, alice, id, created.id)).toBe(true);

    let history = await listConversationHistory(app.db, alice);
    const group = history.groups.find((g) => g.id === created.id);
    expect(group).toMatchObject({ name: 'Sprint 77' });
    expect(group?.conversations.map((c) => c.id)).toEqual([id]);
    expect(history.recent.map((c) => c.id)).not.toContain(id);
    expect(history.groups.map((g) => g.id)).not.toContain(bobs.id);

    expect(await renameGroup(app.db, bob, created.id, 'Taken')).toBe(false);
    expect(await renameGroup(app.db, alice, created.id, '')).toBe(false);
    expect(await renameGroup(app.db, alice, created.id, 'Sprint 77 review')).toBe(true);
    expect(await deleteGroup(app.db, bob, created.id)).toBe(false);
    expect(await deleteGroup(app.db, alice, created.id)).toBe(true);
    history = await listConversationHistory(app.db, alice);
    expect(history.groups.map((g) => g.id)).not.toContain(created.id);
    expect(history.recent.map((c) => c.id)).toContain(id);
    expect((await loadConversation(app.db, alice, id))?.groupId).toBeNull();
  });

  it('caps the number of groups per person', async () => {
    const carol: AgentActor = { orgId: 'org_a', userId: 'user_carol', roles: ['viewer'] };
    for (let i = 0; i < MAX_GROUPS; i++) {
      expect((await createGroup(app.db, carol, `Group ${i}`)).ok).toBe(true);
    }
    expect(await createGroup(app.db, carol, 'One too many')).toEqual({
      ok: false,
      code: 'too_many',
    });
    expect(await createGroup(app.db, alice, '   ')).toEqual({ ok: false, code: 'invalid_name' });
  });
});
