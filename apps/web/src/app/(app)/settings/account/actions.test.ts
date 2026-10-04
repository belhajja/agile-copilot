import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-10-04T12:00:00Z');
const MINUTE = 60_000;

// A signed-in person with no workspace: deletion needs a session only (M3), never an actor.
const session = vi.hoisted(() => ({
  current: {
    user: { id: 'user_1', email: 'Pat@Example.com' },
    session: { createdAt: new Date() },
  },
}));
const privacy = vi.hoisted(() => ({ deleteAccount: vi.fn() }));
const cleared = vi.hoisted(() => [] as { name: string; secure?: boolean; maxAge?: number }[]);

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [
      { name: 'better-auth.session_token' },
      { name: '__Secure-better-auth.session_data' },
      { name: 'NEXT_LOCALE' },
    ],
    set: (name: string, _value: string, opts: { secure?: boolean; maxAge?: number }) =>
      cleared.push({ name, secure: opts.secure, maxAge: opts.maxAge }),
  }),
}));
vi.mock('@agile/privacy', () => privacy);
vi.mock('@/server/context', () => ({
  requireSignedIn: async () => session.current,
  services: () => ({ db: { stub: true } }),
}));

const { deleteAccountAction } = await import('./actions');

const confirm = (value: string) => {
  const form = new FormData();
  form.set('confirm', value);
  return form;
};
const idle = { status: 'idle' } as const;

describe('deleteAccountAction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.clearAllMocks();
    cleared.length = 0;
    session.current.session.createdAt = new Date(NOW.getTime() - 2 * MINUTE);
  });

  it('requires the typed address to match', async () => {
    expect(await deleteAccountAction(idle, confirm('someone@example.com'))).toEqual({
      status: 'error',
      code: 'confirm_mismatch',
    });
    expect(privacy.deleteAccount).not.toHaveBeenCalled();
  });

  it('requires a sign-in less than 10 minutes old (L13)', async () => {
    session.current.session.createdAt = new Date(NOW.getTime() - 11 * MINUTE);
    expect(await deleteAccountAction(idle, confirm('pat@example.com'))).toEqual({
      status: 'error',
      code: 'reauth',
    });
    expect(privacy.deleteAccount).not.toHaveBeenCalled();
  });

  it('reports the workspaces the person is the only owner of', async () => {
    privacy.deleteAccount.mockResolvedValue({
      ok: false,
      code: 'sole_owner',
      workspaces: ['Acme'],
    });
    expect(await deleteAccountAction(idle, confirm(' PAT@example.com '))).toEqual({
      status: 'error',
      code: 'sole_owner',
      workspaces: ['Acme'],
    });
  });

  it('deletes the account of the signed-in person and drops the session cookies', async () => {
    privacy.deleteAccount.mockResolvedValue({ ok: true, workspaces: 0 });
    await expect(deleteAccountAction(idle, confirm('pat@example.com'))).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(privacy.deleteAccount).toHaveBeenCalledWith({ stub: true }, 'user_1');
    expect(cleared).toEqual([
      { name: 'better-auth.session_token', secure: false, maxAge: 0 },
      // A __Secure- cookie is only replaced by a Secure Set-Cookie.
      { name: '__Secure-better-auth.session_data', secure: true, maxAge: 0 },
    ]);
  });

  it('drops the session cookies of an account that no longer exists', async () => {
    privacy.deleteAccount.mockResolvedValue({ ok: false, code: 'not_found' });
    await expect(deleteAccountAction(idle, confirm('pat@example.com'))).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(cleared.map((c) => c.name)).toEqual([
      'better-auth.session_token',
      '__Secure-better-auth.session_data',
    ]);
  });
});
