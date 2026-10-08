import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
const deps = { db: { stub: true } };

const connections = vi.hoisted(() => ({
  createJiraConnection: vi.fn(),
  deleteJiraConnection: vi.fn(),
  retestJiraConnection: vi.fn(),
}));
const requireActor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@agile/connections', async (importActual) => ({
  ForbiddenError: (await importActual<typeof import('@agile/connections')>()).ForbiddenError,
  ...connections,
}));
vi.mock('@/server/atlassian', () => ({ atlassianOAuth: () => null }));
vi.mock('@/server/context', () => ({ requireActor, connectionDeps: () => deps }));

const { ForbiddenError } = await import('@agile/connections');
const actions = await import('./actions');

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const pat = { kind: 'datacenter_pat', name: 'DC', baseUrl: 'https://jira.example.com', token: 't' };

describe('Jira connection actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActor.mockResolvedValue(actor);
  });

  it('creates a Data Center connection from the form', async () => {
    connections.createJiraConnection.mockResolvedValue({ ok: true });
    expect(await actions.createJiraConnectionAction({ status: 'idle' }, form(pat))).toEqual({
      status: 'ok',
    });
    expect(connections.createJiraConnection).toHaveBeenCalledWith(deps, actor, {
      name: 'DC',
      credentials: { kind: 'datacenter_pat', baseUrl: 'https://jira.example.com', token: 't' },
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/jira');
  });

  it.each([
    ['a form missing its token', form({ ...pat, token: '' })],
    ['an unknown kind', form({ ...pat, kind: 'oauth' })],
    ['a cloud form without an e-mail', form({ ...pat, kind: 'cloud_basic', apiToken: 'x' })],
    ['a plain object instead of a form', pat],
    ['nothing', undefined],
  ])('refuses %s', async (_name, input) => {
    expect(await actions.createJiraConnectionAction({ status: 'idle' }, input)).toEqual({
      status: 'error',
      code: 'invalid_input',
    });
    expect(connections.createJiraConnection).not.toHaveBeenCalled();
  });

  it('answers forbidden_role for a member who cannot manage connections', async () => {
    connections.createJiraConnection.mockRejectedValue(new ForbiddenError('no'));
    expect(await actions.createJiraConnectionAction({ status: 'idle' }, form(pat))).toEqual({
      status: 'error',
      code: 'forbidden_role',
    });
  });

  it('asks for a session before anything else', async () => {
    requireActor.mockRejectedValue(new Error('REDIRECT:/login'));
    await expect(actions.createJiraConnectionAction({ status: 'idle' }, form(pat))).rejects.toThrow(
      'REDIRECT:/login',
    );
    await expect(actions.deleteJiraConnectionAction(ID)).rejects.toThrow('REDIRECT:/login');
    expect(connections.createJiraConnection).not.toHaveBeenCalled();
    expect(connections.deleteJiraConnection).not.toHaveBeenCalled();
  });

  it('retests and deletes by id', async () => {
    await actions.retestJiraConnectionAction(ID);
    await actions.deleteJiraConnectionAction(ID);
    expect(connections.retestJiraConnection).toHaveBeenCalledWith(
      { ...deps, oauth: undefined },
      actor,
      ID,
    );
    expect(connections.deleteJiraConnection).toHaveBeenCalledWith(deps, actor, ID);
  });

  it.each(['nope', 42, null])('ignores the id %j', async (id) => {
    await actions.retestJiraConnectionAction(id);
    await actions.deleteJiraConnectionAction(id);
    expect(connections.retestJiraConnection).not.toHaveBeenCalled();
    expect(connections.deleteJiraConnection).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
