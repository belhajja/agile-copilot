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
const finish = vi.fn(async () => {});
const chunks = async function* () {
  yield '{"user":';
  yield '{"id":"user_1"}}';
};
type Opened =
  | { ok: true; chunks: AsyncGenerator<string>; finish: () => Promise<void> }
  | { ok: false; code: string };
const openUserExport = vi.fn(
  async (_db: unknown, _userId: string): Promise<Opened> => ({
    ok: true,
    chunks: chunks(),
    finish,
  }),
);
vi.mock('@agile/privacy', () => ({
  openUserExport: (db: unknown, userId: string) => openUserExport(db, userId),
}));

const { GET } = await import('./route');

const get = () => GET(new Request('http://localhost:3200/api/account/export'));

describe('GET /api/account/export', () => {
  beforeEach(() => {
    currentSession.mockResolvedValue(signedIn);
    openUserExport.mockClear();
    finish.mockClear();
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
    expect(openUserExport).toHaveBeenCalledWith({ stub: true }, 'user_1');
    expect(finish).toHaveBeenCalled();
  });

  it('answers 401 without a session', async () => {
    currentSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(openUserExport).not.toHaveBeenCalled();
  });

  it('answers 404 when the account no longer exists', async () => {
    openUserExport.mockResolvedValueOnce({ ok: false, code: 'not_found' });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 429 with a fixed code while an export runs or after too many', async () => {
    for (const code of ['export_in_progress', 'export_rate_limited']) {
      openUserExport.mockResolvedValueOnce({ ok: false, code });
      const res = await get();
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: code });
    }
  });
});
