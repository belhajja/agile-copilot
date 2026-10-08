import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const GROUP = '6a1e3c55-2b7d-4f0e-9c61-0d9f4b2a7e30';
const actor = { orgId: 'org_1', userId: 'user_1', roles: ['viewer'] };
const db = { stub: true };

const store = vi.hoisted(() => ({
  createGroup: vi.fn(),
  deleteConversation: vi.fn(),
  deleteGroup: vi.fn(),
  moveConversationToGroup: vi.fn(),
  renameConversation: vi.fn(),
  renameGroup: vi.fn(),
  setConversationArchived: vi.fn(),
  setConversationModel: vi.fn(),
}));
const pinWidget = vi.hoisted(() => vi.fn());
const requireActor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
// The real limits (client-safe), without loading the agent itself.
vi.mock('@agile/agent', async () => ({ ...(await import('@agile/agent/limits')), ...store }));
vi.mock('@agile/dashboards', () => ({ pinWidget }));
vi.mock('@/server/context', () => ({ requireActor, services: () => ({ db }) }));

const actions = await import('./actions');

describe('conversation actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActor.mockResolvedValue(actor);
  });

  it('renames the conversation as the actor and refreshes the sidebar', async () => {
    store.renameConversation.mockResolvedValue(true);
    expect(await actions.renameConversationAction(ID, '  Sprint review  ')).toEqual({ ok: true });
    expect(store.renameConversation).toHaveBeenCalledWith(db, actor, ID, 'Sprint review');
    expect(revalidatePath).toHaveBeenCalledWith('/agent', 'layout');
  });

  it.each([
    ['renameConversationAction', ['nope', 'Title'], 'invalid'],
    ['renameConversationAction', [ID, ''], 'invalid'],
    ['renameConversationAction', [ID, 'x'.repeat(81)], 'invalid'],
    ['archiveConversationAction', [ID, 'yes'], 'not_found'],
    ['deleteConversationAction', [42, false], 'not_found'],
    ['setConversationModelAction', [ID, 'gpt'], 'invalid'],
    ['moveConversationAction', [ID, { id: GROUP }], 'not_found'],
    ['createGroupAction', ['   ', ID], 'invalid'],
    ['createGroupAction', ['Team', 'nope'], 'invalid'],
    ['renameGroupAction', [GROUP, 7], 'invalid'],
    ['deleteGroupAction', ['../x'], 'not_found'],
  ] as const)('%s refuses %j with %s before asking for a session', async (name, args, code) => {
    const action = actions[name] as (...a: unknown[]) => Promise<unknown>;
    expect(await action(...args)).toEqual({ ok: false, code });
    expect(requireActor).not.toHaveBeenCalled();
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('asks for a session before changing anything', async () => {
    requireActor.mockRejectedValue(new Error('REDIRECT:/login'));
    await expect(actions.deleteGroupAction(GROUP)).rejects.toThrow('REDIRECT:/login');
    expect(store.deleteGroup).not.toHaveBeenCalled();
  });

  it('answers not_found when the store finds nothing of the actor', async () => {
    store.deleteGroup.mockResolvedValue(false);
    expect(await actions.deleteGroupAction(GROUP)).toEqual({ ok: false, code: 'not_found' });
  });

  it('refuses to delete a conversation while it is answering', async () => {
    store.deleteConversation.mockResolvedValue('turn_in_progress');
    expect(await actions.deleteConversationAction(ID, true)).toEqual({
      ok: false,
      code: 'turn_in_progress',
    });
  });

  it('leaves the deleted open conversation for a new chat', async () => {
    store.deleteConversation.mockResolvedValue('deleted');
    await expect(actions.deleteConversationAction(ID, true)).rejects.toThrow('REDIRECT:/agent');
  });

  it('files the conversation in the group it creates', async () => {
    store.createGroup.mockResolvedValue({ ok: true, id: GROUP });
    store.moveConversationToGroup.mockResolvedValue(true);
    expect(await actions.createGroupAction(' Team ', ID)).toEqual({ ok: true });
    expect(store.createGroup).toHaveBeenCalledWith(db, actor, 'Team');
    expect(store.moveConversationToGroup).toHaveBeenCalledWith(db, actor, ID, GROUP);
  });
});

describe('pinResultAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActor.mockResolvedValue(actor);
  });

  it('pins to the board of the result as the user', async () => {
    pinWidget.mockResolvedValue({ ok: true, alreadyPinned: false });
    const widget = { kind: 'velocity' };
    expect(await actions.pinResultAction({ boardId: ID, widget })).toEqual({
      ok: true,
      boardId: ID,
      alreadyPinned: false,
    });
    expect(pinWidget).toHaveBeenCalledWith(
      db,
      { orgId: 'org_1', userId: 'user_1' },
      { boardId: ID, widget, via: 'user' },
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/boards/${ID}`);
  });

  it.each([{ boardId: 'nope', widget: {} }, { boardId: ID, widget: 'chart' }, { boardId: ID }])(
    'refuses the malformed input %j',
    async (input) => {
      expect(await actions.pinResultAction(input as never)).toEqual({
        ok: false,
        code: 'invalid_widget',
      });
      expect(pinWidget).not.toHaveBeenCalled();
    },
  );

  it('answers a code, not the error, when pinning throws', async () => {
    pinWidget.mockRejectedValue(new Error('db down: secret'));
    expect(await actions.pinResultAction({ boardId: ID, widget: {} })).toEqual({
      ok: false,
      code: 'unknown',
    });
  });
});
