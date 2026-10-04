import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const skill = {
  id: '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11',
  name: 'Weekly review',
  description: 'd',
  trigger: 'on_demand',
  output: 'chat',
  visibility: 'workspace',
  enabled: true,
  ownerUserId: 'other',
  ownerName: 'Sam',
  lastRun: null,
};

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((k: string) => k, { has: () => true }),
  getFormatter: async () => ({ relativeTime: () => '' }),
}));
vi.mock('@agile/skills', () => ({
  BUILTIN_SKILLS: [{ key: 'retro-prep' }],
  listSkills: async () => ({ mine: [], shared: [skill] }),
}));
vi.mock('./actions', () => ({ copyBuiltinSkillAction: async () => undefined }));
vi.mock('@/server/context', () => ({
  requireActor: async () => ({ orgId: 'org', userId: 'user', roles: ['viewer'] }),
  services: () => ({ db: {} }),
}));

const { default: SkillsPage } = await import('./page');

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

describe('Skills page', () => {
  it('offers no copy or fork form on the Shared tab (P4-R8)', async () => {
    const tree = await SkillsPage({ searchParams: Promise.resolve({}) });
    const [shared] = find(tree, (e) => e.props.value === 'shared' && e.props.className === 'mt-4');
    expect(shared).toBeDefined();
    expect(find(shared, (e) => e.type === 'form' || 'action' in e.props)).toEqual([]);
    expect(find(shared, (e) => e.props.href === `/skills/${skill.id}`).length).toBeGreaterThan(0);
  });

  it.each(['constructor', '__proto__', 'library.retro-prep.title', ['a', 'b']])(
    'shows the unknown message for ?error=%j',
    async (error) => {
      const tree = await SkillsPage({ searchParams: Promise.resolve({ error }) });
      const [alert] = find(tree, (e) => e.props.variant === 'destructive');
      expect(JSON.stringify(alert?.props.children)).toContain('errors.unknown');
    },
  );

  it('shows a known code and opens the tab it came from', async () => {
    const tree = await SkillsPage({
      searchParams: Promise.resolve({ error: 'forbidden_output', tab: 'library' }),
    });
    const [alert] = find(tree, (e) => e.props.variant === 'destructive');
    expect(JSON.stringify(alert?.props.children)).toContain('errors.forbidden_output');
    expect(find(tree, (e) => e.props.defaultValue === 'library')).toHaveLength(1);
  });
});
