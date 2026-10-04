import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const ACTOR = { orgId: 'org', userId: 'user', roles: ['viewer'] as string[] };

const skillView = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'weekly-review',
  description: 'd',
  trigger: 'schedule',
  output: 'slack',
  visibility: 'workspace',
  enabled: true,
  currentVersion: 2,
  ownerUserId: 'other',
  ownerName: 'Sam',
  builtinKey: null,
  forkedFromId: null,
  channelId: null,
  lastRun: null,
  ...over,
});
const detailOf = (over: Record<string, unknown> = {}, canEdit = false) => ({
  skill: skillView(over),
  document: '---\nname: weekly-review\n---\nText',
  versions: [
    { version: 2, createdAt: new Date(), createdBy: 'other' },
    { version: 1, createdAt: new Date(), createdBy: 'other' },
  ],
  canEdit,
  canDelete: canEdit,
});
const run = {
  id: 'r1',
  trigger: 'manual',
  status: 'succeeded',
  resultCode: null,
  output: 'Report for weekly-review',
  deliveries: { slack: 'sent' },
  version: 2,
  scheduledFor: null,
  createdAt: new Date(),
  finishedAt: new Date(),
};

const store = vi.hoisted(() => ({ getSkill: vi.fn() }));
const automation = vi.hoisted(() => ({ listRuns: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
  getFormatter: async () => ({ dateTime: () => 'date' }),
}));
vi.mock('@agile/skills', () => store);
vi.mock('@agile/auth', () => ({
  canManageConnections: (roles: string[]) => roles.includes('owner') || roles.includes('admin'),
}));
vi.mock('@agile/automation', () => automation);
vi.mock('@agile/notify', () => ({ listDeliveryChannels: async () => [] }));
vi.mock('@/components/agent/agent-markdown', () => ({ AgentMarkdown: () => null }));
vi.mock('@/components/confirm-delete-button', () => ({ ConfirmDeleteButton: () => null }));
vi.mock('../skill-editor', () => ({ SkillEditor: () => null }));
vi.mock('../skill-badges', () => ({ SkillBadges: () => null }));
vi.mock('../actions', () => ({
  deleteSkillAction: async () => undefined,
  forkSkillAction: async () => undefined,
  restoreSkillVersionAction: async () => undefined,
  runSkillNowAction: async () => undefined,
  setSkillEnabledAction: async () => undefined,
  setSkillVisibilityAction: async () => undefined,
}));
vi.mock('@/server/context', () => ({
  requireActor: async () => ACTOR,
  services: () => ({ db: {} }),
}));

const { default: SkillPage } = await import('./page');

const kids = (n: ReactNode): ReactNode[] => {
  if (Array.isArray(n)) return n.flatMap(kids);
  return n === null || n === undefined || typeof n === 'boolean' ? [] : [n];
};
const find = (n: ReactNode, test: (e: ReactElement<Record<string, unknown>>) => boolean) => {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (x: ReactNode) => {
    for (const c of kids(x)) {
      if (!isValidElement<Record<string, unknown>>(c)) continue;
      if (test(c)) out.push(c);
      walk(c.props.children as ReactNode);
    }
  };
  walk(n);
  return out;
};
const has = (attr: string) => (e: ReactElement<Record<string, unknown>>) => attr in e.props;
const text = (n: unknown) => JSON.stringify(n);

const render = (searchParams: Record<string, unknown> = {}) =>
  SkillPage({
    params: Promise.resolve({ skillId: ID }),
    searchParams: Promise.resolve(searchParams),
  });

describe('a skill page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ACTOR.roles = ['viewer'];
    automation.listRuns.mockResolvedValue([run]);
  });

  it('asks listRuns as the actor, so reports stay the owner’s (P4-R1)', async () => {
    store.getSkill.mockResolvedValue(detailOf());
    await render();
    expect(automation.listRuns).toHaveBeenCalledWith({}, ACTOR, ID, 10);
  });

  it('never renders a report or delivery details for anyone but the owner (P4-R1)', async () => {
    store.getSkill.mockResolvedValue(detailOf());
    const tree = await render();
    expect(find(tree, has('data-run'))).toHaveLength(1);
    expect(find(tree, has('data-run-output'))).toEqual([]);
    expect(find(tree, has('data-delivery'))).toEqual([]);
  });

  it('shows the owner the latest report and its deliveries', async () => {
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
    const tree = await render();
    expect(find(tree, has('data-run-output'))).toHaveLength(1);
    expect(find(tree, (e) => e.props['data-delivery'] === 'slack')).toHaveLength(1);
  });

  it('offers the copy only here, with its full text and the hint that it starts off (P4-R8)', async () => {
    store.getSkill.mockResolvedValue(detailOf());
    const tree = await render();
    expect(find(tree, (e) => e.props['data-skill-text'] !== undefined)).toHaveLength(1);
    expect(text(tree)).toContain('copyHint');
    expect(find(tree, (e) => e.type === 'form')).toHaveLength(1);
  });

  it('asks the owner of a disabled copy to turn it on after reviewing it', async () => {
    store.getSkill.mockResolvedValue(
      detailOf({ ownerUserId: 'user', forkedFromId: ID, enabled: false }, true),
    );
    expect(text(await render())).toContain('enableCopyHint');
  });

  it.each(['constructor', '__proto__', 'editor.errors.invalid', ['a', 'b']])(
    'shows the unknown message for ?error=%j and ?run=%j',
    async (code) => {
      store.getSkill.mockResolvedValue(detailOf());
      const tree = await render({ error: code, run: code });
      const [error] = find(tree, (e) => e.props['data-error'] !== undefined);
      expect(text(error?.props.children)).toContain('errors.unknown');
      const [request] = find(tree, (e) => e.props['data-run-request'] !== undefined);
      expect(request?.props['data-run-request']).toBe('unknown');
      expect(text(request?.props.children)).toContain('runRequest.unknown');
    },
  );

  it('explains a refused copy of a Slack skill (forbidden_output, P4-R4)', async () => {
    store.getSkill.mockResolvedValue(detailOf());
    const tree = await render({ error: 'forbidden_output' });
    const [error] = find(tree, (e) => e.props['data-error'] !== undefined);
    expect(text(error?.props.children)).toContain('errors.forbidden_output');
  });

  it('shows a queued run', async () => {
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
    const tree = await render({ run: 'queued' });
    expect(find(tree, (e) => e.props['data-run-request'] === 'queued')).toHaveLength(1);
  });

  it('is not found when the skill is not readable', async () => {
    store.getSkill.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('NOT_FOUND');
  });

  it('remounts the editor on the new version after a restore (I1)', async () => {
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
    const [before] = find(await render(), has('initialDocument'));
    expect(before?.key).toBe('2');
    expect(before?.props.baseVersion).toBe(2);
    store.getSkill.mockResolvedValue({
      ...detailOf({ ownerUserId: 'user', currentVersion: 3 }, true),
      document: 'restored',
    });
    const [after] = find(await render({ restored: '1' }), has('initialDocument'));
    expect(after?.key).toBe('3');
    expect(after?.props).toMatchObject({ baseVersion: 3, initialDocument: 'restored' });
  });

  it('offers Slack/Teams channels in the editor to owners and admins only (M3, P4-R4)', async () => {
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
    const [viewer] = find(await render(), has('initialDocument'));
    expect(viewer?.props.canPostToChannels).toBe(false);
    ACTOR.roles = ['manager'];
    const [manager] = find(await render(), has('initialDocument'));
    expect(manager?.props.canPostToChannels).toBe(false);
    ACTOR.roles = ['admin'];
    const [admin] = find(await render(), has('initialDocument'));
    expect(admin?.props.canPostToChannels).toBe(true);
  });

  it('offers "Run now" only while the skill is on, and says why (M6)', async () => {
    const runNow = (tree: unknown) =>
      find(tree as ReactNode, (e) => e.type === 'form' && text(e).includes('runNow'));
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
    const on = await render();
    expect(runNow(on)).toHaveLength(1);
    expect(find(on, has('data-run-now-off'))).toEqual([]);
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user', enabled: false }, true));
    const off = await render();
    expect(runNow(off)).toEqual([]);
    expect(find(off, has('data-run-now-off'))).toHaveLength(1);
  });

  it('shows others one status per run: no failure next to "Done" (M7)', async () => {
    automation.listRuns.mockResolvedValue([
      { ...run, status: 'succeeded', resultCode: 'delivery_failed' },
    ]);
    store.getSkill.mockResolvedValue(detailOf());
    const others = await render();
    expect(find(others, has('data-result-code'))).toEqual([]);
    expect(text(others)).not.toContain('resultCodes.');
    store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
    const [mine] = find(await render(), has('data-result-code'));
    expect(mine?.props['data-result-code']).toBe('delivery_failed');
  });

  it.each(['owner_limit', 'user_limit', 'disabled'])(
    'explains a "Run now" that was not queued (?run=%s, P4-R30)',
    async (code) => {
      store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
      const [request] = find(
        await render({ run: code }),
        (e) => e.props['data-run-request'] !== undefined,
      );
      expect(request?.props['data-run-request']).toBe(code);
    },
  );

  it.each(['delivery_failed', 'forbidden_role'])(
    'shows others a generic failure instead of %s (M4)',
    async (resultCode) => {
      automation.listRuns.mockResolvedValue([{ ...run, status: 'failed', resultCode }]);
      store.getSkill.mockResolvedValue(detailOf());
      const others = text(await render());
      expect(others).toContain('resultCodes.unknown');
      expect(others).not.toContain(`resultCodes.${resultCode}`);
      store.getSkill.mockResolvedValue(detailOf({ ownerUserId: 'user' }, true));
      expect(text(await render())).toContain(`resultCodes.${resultCode}`);
    },
  );
});
