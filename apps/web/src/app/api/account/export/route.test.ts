import { beforeEach, describe, expect, it, vi } from 'vitest';

// A signed-in person with no workspace: the export needs a session only (M3), never an actor.
const signedIn = { user: { id: 'user_1' }, session: { activeOrganizationId: null } };
const currentSession = vi.fn(
  async (_headers: Headers): Promise<typeof signedIn | null> => signedIn,
);
vi.mock('@/server/context', () => ({
  currentSession: (headers: Headers) => currentSession(headers),
  services: () => ({ db: { stub: true }, env: { BETTER_AUTH_URL: 'http://localhost:3200' } }),
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

const route = await import('./route');

const SAME_ORIGIN = { origin: 'http://localhost:3200' };
const post = (headers: Record<string, string> = SAME_ORIGIN) =>
  route.POST(new Request('http://localhost:3200/api/account/export', { method: 'POST', headers }));
const get = () => post();

describe('POST /api/account/export', () => {
  beforeEach(() => {
    currentSession.mockClear();
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

  it('is a POST from our own pages only: a cross-site link or form cannot spend the quota (A-m5)', async () => {
    expect('GET' in route).toBe(false);
    for (const headers of [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      {} as Record<string, string>,
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
    expect(currentSession).not.toHaveBeenCalled();
    expect(openUserExport).not.toHaveBeenCalled();
  });

  it('sends a throttled browser form back to the account page', async () => {
    for (const code of ['export_in_progress', 'export_rate_limited']) {
      openUserExport.mockResolvedValueOnce({ ok: false, code });
      const res = await post({ ...SAME_ORIGIN, accept: 'text/html,application/xhtml+xml' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/settings/account?export_error=${code}`);
    }
  });
});
