import { afterEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
// Never reached for a member: the services refuse before touching the database.
vi.mock('@/server/automation', () => ({ notifyDeps: () => ({}) }));
vi.mock('@/server/context', () => ({
  requireActor: async () => ({ orgId: 'org', userId: 'user', roles: ['member'] }),
  connectionDeps: () => ({}),
}));

const { createChannelAction, deleteChannelAction } = await import(
  '../app/(app)/settings/delivery/actions'
);
const { setBackgroundLlmConnectionAction } = await import('../app/(app)/settings/llm/actions');

describe('settings actions called by a plain member', () => {
  afterEach(() => vi.restoreAllMocks());

  it('createChannelAction answers forbidden_role', async () => {
    const form = new FormData();
    form.set('kind', 'slack');
    form.set('name', 'Team');
    form.set('url', 'https://hooks.slack.com/services/T/B/x');
    expect(await createChannelAction({ status: 'idle' }, form)).toEqual({
      status: 'error',
      code: 'forbidden_role',
    });
  });

  it('deleteChannelAction answers forbidden_role', async () => {
    expect(await deleteChannelAction(ID)).toEqual({ ok: false, code: 'forbidden_role' });
  });

  it('setBackgroundLlmConnectionAction answers forbidden_role', async () => {
    expect(await setBackgroundLlmConnectionAction(ID)).toEqual({
      ok: false,
      code: 'forbidden_role',
    });
    expect(await setBackgroundLlmConnectionAction(null)).toEqual({
      ok: false,
      code: 'forbidden_role',
    });
  });
});
