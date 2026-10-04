import { beforeEach, describe, expect, it, vi } from 'vitest';

// A signed-in person with no workspace: the export needs a session only (M3), never an actor.
const signedIn = { user: { id: 'user_1' }, session: { activeOrganizationId: null } };
const currentSession = vi.fn(
  async (_headers: Headers): Promise<typeof signedIn | null> => signedIn,
);
vi.mock('@/server/context', () => ({
  currentSession: (headers: Headers) => currentSession(headers),
  services: () => ({ db: { stub: true } }),
}));
const exportUserData = vi.fn(async function* (_db: unknown, _userId: string) {
  yield '{"user":';
  yield '{"id":"user_1"}}';
});
vi.mock('@agile/privacy', () => ({
  exportUserData: (db: unknown, userId: string) => exportUserData(db, userId),
}));

const { GET } = await import('./route');

const get = () => GET(new Request('http://localhost:3200/api/account/export'));

describe('GET /api/account/export', () => {
  beforeEach(() => {
    currentSession.mockResolvedValue(signedIn);
    exportUserData.mockClear();
  });

  it('streams the signed-in person’s data as a JSON download, without needing a workspace', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="agile-copilot-my-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(await res.text())).toEqual({ user: { id: 'user_1' } });
    expect(exportUserData).toHaveBeenCalledWith({ stub: true }, 'user_1');
  });

  it('answers 401 without a session', async () => {
    currentSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(exportUserData).not.toHaveBeenCalled();
  });
});
