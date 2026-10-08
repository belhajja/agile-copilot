import { beforeEach, describe, expect, it, vi } from 'vitest';

const CONNECTION = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const BOARD = '6a1e3c55-2b7d-4f0e-9c61-0d9f4b2a7e30';
const actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
const deps = { db: { stub: true } };
const boss = { stub: 'boss' };

const sync = vi.hoisted(() => ({
  discoverBoards: vi.fn(),
  requestSync: vi.fn(),
  saveStatusMappings: vi.fn(),
  setBoardSelection: vi.fn(),
}));
const requireActor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@agile/sync', () => sync);
vi.mock('@agile/connections', async (importActual) => ({
  ForbiddenError: (await importActual<typeof import('@agile/connections')>()).ForbiddenError,
}));
vi.mock('@/server/billing', () => ({ entitlements: async () => ({ maxBoards: 5 }) }));
vi.mock('@/server/context', () => ({ requireActor, services: () => ({ db: deps.db }) }));
vi.mock('@/server/sync', () => ({ syncDeps: () => deps, syncQueue: async () => boss }));

const { ForbiddenError } = await import('@agile/connections');
const actions = await import('./actions');
const idle = { status: 'idle' } as const;

const boards = (...ids: string[]) => {
  const f = new FormData();
  for (const id of ids) f.append('board', id);
  return f;
};
const mapping = (entries: [string, string, boolean][]) => {
  const f = new FormData();
  for (const [id, category, blocked] of entries) {
    f.append('status', id);
    f.set(`category:${id}`, category);
    if (blocked) f.set(`blocked:${id}`, 'on');
  }
  return f;
};

describe('board actions of a Jira connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActor.mockResolvedValue(actor);
  });

  it('saves the board selection within the plan quota', async () => {
    sync.setBoardSelection.mockResolvedValue({ ok: true });
    expect(await actions.saveBoardSelectionAction(CONNECTION, idle, boards(BOARD))).toEqual({
      status: 'ok',
    });
    expect(sync.setBoardSelection).toHaveBeenCalledWith(deps, actor, CONNECTION, [BOARD], {
      maxSelectedBoards: 5,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/settings/jira/${CONNECTION}`);
  });

  it.each([
    ['a bad connection id', ['nope', boards(BOARD)]],
    ['a bad board id', [CONNECTION, boards('nope')]],
    ['no form', [CONNECTION, { board: BOARD }]],
  ])('refuses a selection with %s', async (_name, [id, form]) => {
    expect(await actions.saveBoardSelectionAction(id, idle, form)).toEqual({
      status: 'error',
      code: 'invalid_input',
    });
    expect(sync.setBoardSelection).not.toHaveBeenCalled();
  });

  it('saves the status mapping of a board', async () => {
    sync.saveStatusMappings.mockResolvedValue({ ok: true });
    const form = mapping([
      ['10001', 'done', false],
      ['10002', 'in_progress', true],
    ]);
    expect(await actions.saveStatusMappingAction(CONNECTION, BOARD, idle, form)).toEqual({
      status: 'ok',
    });
    expect(sync.saveStatusMappings).toHaveBeenCalledWith(deps, actor, BOARD, [
      { jiraStatusId: '10001', category: 'done', blocked: false },
      { jiraStatusId: '10002', category: 'in_progress', blocked: true },
    ]);
  });

  it.each([
    ['a bad connection id', ['../x', BOARD, mapping([['1', 'done', false]])]],
    ['a bad board id', [CONNECTION, 'nope', mapping([['1', 'done', false]])]],
    ['an unknown category', [CONNECTION, BOARD, mapping([['1', 'blocked', false]])]],
    ['no status', [CONNECTION, BOARD, mapping([])]],
    ['no form', [CONNECTION, BOARD, 'status=1']],
  ])('refuses a mapping with %s', async (_name, [id, board, form]) => {
    expect(await actions.saveStatusMappingAction(id, board, idle, form)).toEqual({
      status: 'error',
      code: 'invalid_input',
    });
    expect(sync.saveStatusMappings).not.toHaveBeenCalled();
  });

  it('answers not_found for a bad id on discovery and sync', async () => {
    expect(await actions.discoverBoardsAction('nope')).toEqual({
      status: 'error',
      code: 'not_found',
    });
    expect(await actions.requestSyncAction(42)).toEqual({ status: 'error', code: 'not_found' });
    expect(sync.discoverBoards).not.toHaveBeenCalled();
    expect(sync.requestSync).not.toHaveBeenCalled();
  });

  it('queues a sync and says whether it was queued', async () => {
    sync.requestSync.mockResolvedValue({ ok: true, queued: false });
    expect(await actions.requestSyncAction(CONNECTION)).toEqual({ status: 'ok', queued: false });
    expect(sync.requestSync).toHaveBeenCalledWith({ db: deps.db, boss }, actor, CONNECTION);
  });

  it('answers forbidden_role for a member who cannot manage connections', async () => {
    sync.discoverBoards.mockRejectedValue(new ForbiddenError('no'));
    expect(await actions.discoverBoardsAction(CONNECTION)).toEqual({
      status: 'error',
      code: 'forbidden_role',
    });
  });

  it('asks for a session before anything else', async () => {
    requireActor.mockRejectedValue(new Error('REDIRECT:/login'));
    await expect(actions.requestSyncAction(CONNECTION)).rejects.toThrow('REDIRECT:/login');
    await expect(actions.saveBoardSelectionAction(CONNECTION, idle, boards(BOARD))).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(sync.requestSync).not.toHaveBeenCalled();
    expect(sync.setBoardSelection).not.toHaveBeenCalled();
  });
});
