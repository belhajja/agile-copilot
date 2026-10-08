import { beforeEach, describe, expect, it, vi } from 'vitest';

const set = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }));

const { setLocale } = await import('./locale');

describe('setLocale', () => {
  beforeEach(() => set.mockReset());

  it('remembers a supported locale for a year', async () => {
    await setLocale('fr');
    expect(set).toHaveBeenCalledWith('locale', 'fr', {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  });

  it.each(['de', 'FR', '', 42, null, { locale: 'fr' }])('ignores %j', async (locale) => {
    await setLocale(locale);
    expect(set).not.toHaveBeenCalled();
  });
});
