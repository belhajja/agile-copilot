import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
const deps = { db: { stub: true } };

const notify = vi.hoisted(() => ({
  createDeliveryChannel: vi.fn(),
  deleteDeliveryChannel: vi.fn(),
}));
const requireActor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@agile/notify', () => ({
  ...notify,
  digestLabels: () => ({ testTitle: 'Test', testText: 'Hello' }),
}));
vi.mock('@agile/connections', async (importActual) => ({
  ForbiddenError: (await importActual<typeof import('@agile/connections')>()).ForbiddenError,
}));
vi.mock('@/server/automation', () => ({ notifyDeps: () => deps }));
vi.mock('@/server/context', () => ({ requireActor }));

const { ForbiddenError } = await import('@agile/connections');
const actions = await import('./actions');
const idle = { status: 'idle' } as const;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('delivery channel actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActor.mockResolvedValue(actor);
  });

  it('creates a webhook channel from the fields of its kind only', async () => {
    notify.createDeliveryChannel.mockResolvedValue({ ok: true });
    const input = form({ kind: 'slack', name: 'Team', url: 'https://hooks.example', host: 'x' });
    expect(await actions.createChannelAction(idle, input)).toEqual({ status: 'ok' });
    expect(notify.createDeliveryChannel).toHaveBeenCalledWith(
      deps,
      actor,
      { kind: 'slack', name: 'Team', url: 'https://hooks.example' },
      { testMessage: { title: 'Test', text: 'Hello' } },
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings/delivery');
  });

  it.each([{ kind: 'slack' }, 'kind=slack', null])('refuses the non-form %j', async (input) => {
    expect(await actions.createChannelAction(idle, input)).toEqual({
      status: 'error',
      code: 'invalid_input',
    });
    expect(notify.createDeliveryChannel).not.toHaveBeenCalled();
  });

  it('reduces how a webhook test failed to test_failed', async () => {
    notify.createDeliveryChannel.mockResolvedValue({ ok: false, code: 'unreachable' });
    expect(
      await actions.createChannelAction(idle, form({ kind: 'teams', name: 'T', url: 'https://x' })),
    ).toEqual({ status: 'error', code: 'test_failed' });
  });

  it('answers forbidden_role for a member who cannot manage channels', async () => {
    notify.deleteDeliveryChannel.mockRejectedValue(new ForbiddenError('no'));
    expect(await actions.deleteChannelAction(ID)).toEqual({ ok: false, code: 'forbidden_role' });
  });

  it.each(['nope', 42, null])('answers not_found for the id %j', async (id) => {
    expect(await actions.deleteChannelAction(id)).toEqual({ ok: false, code: 'not_found' });
    expect(notify.deleteDeliveryChannel).not.toHaveBeenCalled();
  });

  it('deletes by id and refreshes the page', async () => {
    notify.deleteDeliveryChannel.mockResolvedValue({ ok: true });
    expect(await actions.deleteChannelAction(ID)).toEqual({ ok: true });
    expect(notify.deleteDeliveryChannel).toHaveBeenCalledWith(deps, actor, ID);
    expect(revalidatePath).toHaveBeenCalledWith('/settings/delivery');
  });

  it('asks for a session before anything else', async () => {
    requireActor.mockRejectedValue(new Error('REDIRECT:/login'));
    await expect(actions.deleteChannelAction(ID)).rejects.toThrow('REDIRECT:/login');
    await expect(actions.createChannelAction(idle, form({ kind: 'slack' }))).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(notify.deleteDeliveryChannel).not.toHaveBeenCalled();
    expect(notify.createDeliveryChannel).not.toHaveBeenCalled();
  });
});
