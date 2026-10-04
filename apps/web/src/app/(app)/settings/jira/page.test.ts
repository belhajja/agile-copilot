import { describe, expect, it, vi } from 'vitest';
import en from '../../../../../messages/en.json';

/** next-intl's lookup: a path through the messages, so prototype keys and namespaces resolve. */
const lookup = (path: string) =>
  path
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en.jira);

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () =>
    Object.assign((k: string) => k, { has: (k: string) => lookup(k) !== undefined }),
}));
vi.mock('@agile/auth', () => ({ canManageConnections: () => true }));
vi.mock('@agile/connections', () => ({ listJiraConnections: async () => [] }));
vi.mock('@/server/context', () => ({
  connectionDeps: () => ({}),
  requireActor: async () => ({ orgId: 'org', userId: 'user', roles: ['owner'] }),
  services: () => ({ db: {}, env: {} }),
}));
vi.mock('./jira-connection-form', () => ({ JiraConnectionForm: () => null }));
vi.mock('./jira-connection-item', () => ({ JiraConnectionItem: () => null }));

const { default: JiraSettingsPage } = await import('./page');

const render = async (error: string) =>
  JSON.stringify(await JiraSettingsPage({ searchParams: Promise.resolve({ error }) }));

describe('the Jira settings page (?error=, M4)', () => {
  it('shows the sentence of a known code', async () => {
    expect(await render('oauth_failed')).toContain('errors.oauth_failed');
  });

  it.each(['constructor', '__proto__', 'toString', 'blocked', 'blocked.scheme', 'unknown.x'])(
    'shows the unknown message for ?error=%s',
    async (error) => {
      const page = await render(error);
      expect(page).toContain('errors.unknown');
      expect(page).not.toContain(`errors.${error}`);
    },
  );
});
