import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';

const store = vi.hoisted(() => ({
  copyBuiltinSkill: vi.fn(),
  forkSkill: vi.fn(),
  setSkillVisibility: vi.fn(),
  setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
}));
const automation = vi.hoisted(() => ({ requestSkillRun: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@agile/skills', () => store);
vi.mock('@agile/automation', () => automation);
vi.mock('@/server/automation', () => ({ skillQueue: vi.fn(), skillRunsDailyLimit: () => 50 }));
vi.mock('@/server/context', () => ({
  requireActor: async () => ({ orgId: 'org', userId: 'user', roles: ['member'] }),
  services: () => ({ db: {} }),
}));

const actions = await import('./actions');

describe('skills actions never fail silently (P4-R11)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the code of a refused copy back to the list', async () => {
    store.copyBuiltinSkill.mockResolvedValue({ ok: false, code: 'forbidden_output' });
    await expect(actions.copyBuiltinSkillAction('retro-prep')).rejects.toThrow(
      'REDIRECT:/skills?error=forbidden_output&tab=library',
    );
  });

  it('sends the code of a refused copy of a shared skill back to its page', async () => {
    store.forkSkill.mockResolvedValue({ ok: false, code: 'duplicate_name' });
    await expect(actions.forkSkillAction(ID)).rejects.toThrow(
      `REDIRECT:/skills/${ID}?error=duplicate_name`,
    );
  });

  it('opens the copy it made', async () => {
    store.forkSkill.mockResolvedValue({ ok: true, id: ID });
    await expect(actions.forkSkillAction(ID)).rejects.toThrow(`REDIRECT:/skills/${ID}`);
  });

  it('reports a refused enable, share and delete', async () => {
    store.setSkillEnabled.mockResolvedValue({ ok: false, code: 'forbidden' });
    store.setSkillVisibility.mockResolvedValue({ ok: false, code: 'forbidden' });
    store.deleteSkill.mockResolvedValue({ ok: false, code: 'forbidden' });
    const to = `REDIRECT:/skills/${ID}?error=forbidden`;
    await expect(actions.setSkillEnabledAction(ID, true)).rejects.toThrow(to);
    await expect(actions.setSkillVisibilityAction(ID, 'workspace')).rejects.toThrow(to);
    await expect(actions.deleteSkillAction(ID)).rejects.toThrow(to);
  });

  it('answers not_found for an id that is not a uuid', async () => {
    await expect(actions.deleteSkillAction('nope')).rejects.toThrow(
      'REDIRECT:/skills?error=not_found',
    );
    expect(store.deleteSkill).not.toHaveBeenCalled();
  });

  it('goes back to the list, not to the skill page, when the skill is gone', async () => {
    store.setSkillEnabled.mockResolvedValue({ ok: false, code: 'not_found' });
    await expect(actions.setSkillEnabledAction(ID, true)).rejects.toThrow(
      'REDIRECT:/skills?error=not_found&tab=mine',
    );
    store.forkSkill.mockResolvedValue({ ok: false, code: 'not_found' });
    await expect(actions.forkSkillAction(ID)).rejects.toThrow(
      'REDIRECT:/skills?error=not_found&tab=shared',
    );
  });

  it('encodes the code in the redirect', async () => {
    store.copyBuiltinSkill.mockResolvedValue({ ok: false, code: 'a b&c=d' });
    await expect(actions.copyBuiltinSkillAction('retro-prep')).rejects.toThrow(
      'REDIRECT:/skills?error=a%20b%26c%3Dd&tab=library',
    );
  });

  it('refuses a visibility change for a bad uuid without touching the store', async () => {
    await expect(actions.setSkillVisibilityAction('nope', 'workspace')).rejects.toThrow(
      'REDIRECT:/skills?error=not_found',
    );
    expect(store.setSkillVisibility).not.toHaveBeenCalled();
  });

  it('answers not_found for an unknown built-in key', async () => {
    store.copyBuiltinSkill.mockResolvedValue({ ok: false, code: 'not_found' });
    await expect(actions.copyBuiltinSkillAction('nope')).rejects.toThrow(
      'REDIRECT:/skills?error=not_found&tab=library',
    );
  });

  it.each([
    [{ ok: true, queued: true }, 'queued'],
    [{ ok: true, queued: false }, 'daily_limit'],
    [{ ok: false, code: 'forbidden' }, 'forbidden'],
    [{ ok: false, code: 'not_runnable' }, 'not_runnable'],
  ])('runSkillNowAction %j shows run=%s', async (result, run) => {
    automation.requestSkillRun.mockResolvedValue(result);
    await expect(actions.runSkillNowAction(ID)).rejects.toThrow(
      `REDIRECT:/skills/${ID}?run=${run}`,
    );
  });
});
