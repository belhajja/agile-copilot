import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';

const store = vi.hoisted(() => ({
  copyBuiltinSkill: vi.fn(),
  forkSkill: vi.fn(),
  setSkillVisibility: vi.fn(),
  setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  getSkill: vi.fn(),
  getSkillVersion: vi.fn(),
}));
const automation = vi.hoisted(() => ({ requestSkillRun: vi.fn() }));
const agent = vi.hoisted(() => ({
  draftSkill: vi.fn(),
  runSkill: vi.fn(),
  builderCallsSince: vi.fn(),
  SKILL_BUILDER_HOURLY_LIMIT: 20,
}));
const revalidated = vi.hoisted(() => [] as string[]);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
// The real document parser: the actions read a document's output to pick its channel.
vi.mock('@agile/skills', async (importOriginal) => ({
  parseSkillDocument: (await importOriginal<typeof import('@agile/skills')>()).parseSkillDocument,
  ...store,
}));
vi.mock('@agile/agent', () => agent);
vi.mock('@agile/automation', () => automation);
vi.mock('@/server/automation', () => ({
  skillQueue: vi.fn(),
  skillRunsDailyLimit: () => 50,
  skillRunDeps: () => ({ deps: true }),
}));
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

const CHANNEL = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const doc = (output: string, trigger = 'schedule') =>
  [
    '---',
    'name: monday-risks',
    'description: Stories at risk',
    `trigger: ${trigger}`,
    ...(trigger === 'schedule' ? ['schedule:', '  cron: 0 8 * * 1', '  timezone: UTC'] : []),
    `output: ${output}`,
    '---',
    '',
    '1. Call list_boards.',
  ].join('\n');

describe('the skill builder actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revalidated.length = 0;
    agent.builderCallsSince.mockResolvedValue(0);
  });

  it('drafts from a request and saves nothing', async () => {
    agent.draftSkill.mockResolvedValue({ ok: true, document: 'DOC' });
    expect(await actions.draftSkillAction('  every Monday  ')).toEqual({
      ok: true,
      document: 'DOC',
    });
    expect(agent.draftSkill).toHaveBeenCalledWith(
      { deps: true },
      expect.anything(),
      'every Monday',
    );
    expect(store.createSkill).not.toHaveBeenCalled();
    expect(store.updateSkill).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'x'.repeat(2_001)])('refuses the request %j', async (request) => {
    expect(await actions.draftSkillAction(request)).toEqual({ ok: false, code: 'invalid_request' });
    expect(agent.draftSkill).not.toHaveBeenCalled();
  });

  it('returns the draft failure code', async () => {
    agent.draftSkill.mockResolvedValue({ ok: false, code: 'no_llm' });
    expect(await actions.draftSkillAction('x')).toEqual({ ok: false, code: 'no_llm' });
  });

  it('limits drafts and previews to 20 per member and hour (P4-R16)', async () => {
    agent.builderCallsSince.mockResolvedValue(20);
    expect(await actions.draftSkillAction('every Monday')).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    expect(await actions.previewSkillAction(doc('email'))).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    expect(agent.draftSkill).not.toHaveBeenCalled();
    expect(agent.runSkill).not.toHaveBeenCalled();
    const [, actor, since] = agent.builderCallsSince.mock.calls[0] ?? [];
    expect(actor).toMatchObject({ orgId: 'org', userId: 'user' });
    const window = Date.now() - (since as Date).getTime();
    expect(window).toBeGreaterThanOrEqual(3_600_000);
    expect(window).toBeLessThan(3_660_000);
  });

  it('lets the 20th call of the hour through', async () => {
    agent.builderCallsSince.mockResolvedValue(19);
    agent.runSkill.mockResolvedValue({ ok: true, text: 'Report' });
    expect(await actions.previewSkillAction(doc('email'))).toEqual({ ok: true, text: 'Report' });
  });

  it('previews a valid document once, read-only and without delivery', async () => {
    agent.runSkill.mockResolvedValue({ ok: true, text: 'Report' });
    await actions.previewSkillAction(doc('email'));
    expect(agent.runSkill).toHaveBeenCalledTimes(1);
    const [, , req] = agent.runSkill.mock.calls[0] ?? [];
    expect(Object.keys(req)).toEqual(['skill']);
    expect(req.skill.frontmatter.name).toBe('monday-risks');
  });

  it('returns the issues of an invalid document without running it or counting it', async () => {
    const r = await actions.previewSkillAction('no frontmatter');
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.ok ? [] : r.issues).not.toHaveLength(0);
    expect(agent.runSkill).not.toHaveBeenCalled();
    expect(agent.builderCallsSince).not.toHaveBeenCalled();
  });

  it('returns the run failure code of a preview', async () => {
    agent.runSkill.mockResolvedValue({ ok: false, code: 'model_failed' });
    expect(await actions.previewSkillAction(doc('email'))).toEqual({
      ok: false,
      code: 'model_failed',
    });
  });

  it('creates a skill and opens it', async () => {
    store.createSkill.mockResolvedValue({ ok: true, id: ID });
    await expect(
      actions.saveSkillAction({ document: doc('email'), channelId: null }),
    ).rejects.toThrow(`REDIRECT:/skills/${ID}`);
    expect(store.createSkill.mock.calls[0]?.[2]).toMatchObject({
      document: doc('email'),
      channelId: null,
      locale: 'en',
    });
  });

  it('returns the refusal of a new skill with its issues (forbidden_output too)', async () => {
    store.createSkill.mockResolvedValue({ ok: false, code: 'forbidden_output' });
    expect(await actions.saveSkillAction({ document: doc('slack'), channelId: CHANNEL })).toEqual({
      ok: false,
      code: 'forbidden_output',
    });
    const issues = [{ code: 'cron_invalid', field: 'schedule.cron' }];
    store.createSkill.mockResolvedValue({ ok: false, code: 'invalid', issues });
    expect(await actions.saveSkillAction({ document: 'x', channelId: null })).toEqual({
      ok: false,
      code: 'invalid',
      issues,
    });
  });

  it('saves a new version from the version loaded', async () => {
    store.updateSkill.mockResolvedValue({ ok: true, version: 3 });
    expect(
      await actions.saveSkillAction({
        id: ID,
        document: doc('slack'),
        channelId: CHANNEL,
        baseVersion: 2,
      }),
    ).toEqual({ ok: true, version: 3 });
    expect(store.updateSkill).toHaveBeenCalledWith(
      {},
      expect.anything(),
      ID,
      expect.objectContaining({ baseVersion: 2, channelId: CHANNEL }),
    );
    expect(revalidated).toContain(`/skills/${ID}`);
  });

  it('reports version_conflict instead of overwriting another tab', async () => {
    store.updateSkill.mockResolvedValue({ ok: false, code: 'version_conflict' });
    expect(
      await actions.saveSkillAction({
        id: ID,
        document: doc('email'),
        channelId: null,
        baseVersion: 1,
      }),
    ).toEqual({ ok: false, code: 'version_conflict' });
  });

  it('drops the channel of an output that posts nowhere', async () => {
    store.updateSkill.mockResolvedValue({ ok: true, version: 2 });
    await actions.saveSkillAction({
      id: ID,
      document: doc('email'),
      channelId: CHANNEL,
      baseVersion: 1,
    });
    expect(store.updateSkill.mock.calls[0]?.[3]).toMatchObject({ channelId: null });
  });

  it.each([
    { id: 'nope', document: 'x', channelId: null },
    { document: 'x', channelId: 'nope' },
    { id: ID, document: 'x', channelId: null },
    { document: 'x'.repeat(30_001), channelId: null },
  ])('refuses the malformed save %#', async (input) => {
    expect(await actions.saveSkillAction(input as never)).toEqual({
      ok: false,
      code: 'invalid_request',
    });
    expect(store.createSkill).not.toHaveBeenCalled();
    expect(store.updateSkill).not.toHaveBeenCalled();
  });
});

describe('restoring a version', () => {
  beforeEach(() => vi.clearAllMocks());
  const detail = { skill: { id: ID, channelId: CHANNEL, currentVersion: 3 } };

  it('saves the old document as the newest version, with the channel its output needs', async () => {
    store.getSkill.mockResolvedValue(detail);
    store.getSkillVersion.mockResolvedValue(doc('email'));
    store.updateSkill.mockResolvedValue({ ok: true, version: 4 });
    await expect(actions.restoreSkillVersionAction(ID, 1, 3)).rejects.toThrow(
      `REDIRECT:/skills/${ID}?restored=1`,
    );
    expect(store.updateSkill.mock.calls[0]?.[3]).toMatchObject({
      document: doc('email'),
      channelId: null,
      baseVersion: 3,
    });
    store.getSkillVersion.mockResolvedValue(doc('slack'));
    await expect(actions.restoreSkillVersionAction(ID, 2, 4)).rejects.toThrow('REDIRECT');
    expect(store.updateSkill.mock.calls[1]?.[3]).toMatchObject({ channelId: CHANNEL });
  });

  it('never fails silently (P4-R11)', async () => {
    store.getSkill.mockResolvedValue(detail);
    store.getSkillVersion.mockResolvedValue(doc('email'));
    store.updateSkill.mockResolvedValue({ ok: false, code: 'version_conflict' });
    await expect(actions.restoreSkillVersionAction(ID, 1, 2)).rejects.toThrow(
      `REDIRECT:/skills/${ID}?error=version_conflict`,
    );
    store.getSkillVersion.mockResolvedValue(null);
    await expect(actions.restoreSkillVersionAction(ID, 9, 3)).rejects.toThrow(
      `REDIRECT:/skills/${ID}?error=not_found`,
    );
    store.getSkill.mockResolvedValue(null);
    await expect(actions.restoreSkillVersionAction(ID, 1, 3)).rejects.toThrow(
      'REDIRECT:/skills?error=not_found&tab=mine',
    );
    await expect(actions.restoreSkillVersionAction('nope', 1, 3)).rejects.toThrow(
      'REDIRECT:/skills?error=not_found',
    );
  });
});
