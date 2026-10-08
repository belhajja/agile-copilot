import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ acceptInvitation: vi.fn(), rejectInvitation: vi.fn() }));
const requireSignedIn = vi.hoisted(() => vi.fn());
const requestHeaders = new Headers({ cookie: 'session=1' });

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('@/server/context', () => ({
  requireSignedIn,
  services: () => ({ auth: { api } }),
}));

const { acceptInvitationAction, rejectInvitationAction } = await import('./actions');
const idle = { status: 'idle' } as const;

describe('invitation actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSignedIn.mockResolvedValue({ user: { id: 'user_1' } });
  });

  it('accepts as the signed-in user and opens the workspace', async () => {
    await expect(acceptInvitationAction('inv_1', idle)).rejects.toThrow('REDIRECT:/');
    expect(requireSignedIn).toHaveBeenCalledWith('/invitations/inv_1');
    expect(api.acceptInvitation).toHaveBeenCalledWith({
      headers: requestHeaders,
      body: { invitationId: 'inv_1' },
    });
  });

  it('rejects and goes to onboarding', async () => {
    await expect(rejectInvitationAction('inv_1', idle)).rejects.toThrow('REDIRECT:/onboarding');
    expect(api.rejectInvitation).toHaveBeenCalledWith({
      headers: requestHeaders,
      body: { invitationId: 'inv_1' },
    });
  });

  it.each(['', 'x'.repeat(101), 42, null])('refuses the id %j', async (id) => {
    expect(await acceptInvitationAction(id, idle)).toEqual({
      status: 'error',
      code: 'invalid_input',
    });
    expect(await rejectInvitationAction(id, idle)).toEqual({
      status: 'error',
      code: 'invalid_input',
    });
    expect(requireSignedIn).not.toHaveBeenCalled();
    expect(api.acceptInvitation).not.toHaveBeenCalled();
    expect(api.rejectInvitation).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in first, back to the invitation', async () => {
    requireSignedIn.mockRejectedValue(new Error('REDIRECT:/login?next=/invitations/inv_1'));
    await expect(acceptInvitationAction('inv_1', idle)).rejects.toThrow('REDIRECT:/login');
    expect(api.acceptInvitation).not.toHaveBeenCalled();
  });

  it("returns better-auth's code, and unknown for anything else", async () => {
    api.acceptInvitation.mockRejectedValueOnce({ body: { code: 'INVITATION_NOT_FOUND' } });
    expect(await acceptInvitationAction('inv_1', idle)).toEqual({
      status: 'error',
      code: 'INVITATION_NOT_FOUND',
    });
    api.rejectInvitation.mockRejectedValueOnce(new Error('db down'));
    expect(await rejectInvitationAction('inv_1', idle)).toEqual({
      status: 'error',
      code: 'unknown',
    });
  });
});
