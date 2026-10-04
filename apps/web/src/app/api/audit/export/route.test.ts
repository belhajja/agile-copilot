import { beforeEach, describe, expect, it, vi } from 'vitest';

const actor = { orgId: 'org_1', userId: 'user_1', roles: ['admin'] };
const currentActor = vi.fn(async (_headers: Headers): Promise<typeof actor | null> => actor);
vi.mock('@/server/context', () => ({
  currentActor: (headers: Headers) => currentActor(headers),
  services: () => ({ db: { stub: true } }),
}));
const finish = vi.fn(async () => {});
type Opened =
  | { ok: true; chunks: AsyncGenerator<string>; finish: () => Promise<void> }
  | { ok: false; code: string };
const openAuditExport = vi.fn(
  async (_db: unknown, _actor: unknown, _opts: unknown): Promise<Opened> => ({
    ok: true,
    chunks: (async function* () {
      yield 'a,b\r\n';
      yield '1,2\r\n';
    })(),
    finish,
  }),
);
vi.mock('@agile/privacy', () => ({
  openAuditExport: (db: unknown, a: unknown, opts: unknown) => openAuditExport(db, a, opts),
}));

const { GET } = await import('./route');

const get = (query: string) => GET(new Request(`http://localhost:3200/api/audit/export${query}`));

describe('GET /api/audit/export', () => {
  beforeEach(() => {
    currentActor.mockResolvedValue(actor);
    openAuditExport.mockClear();
    finish.mockClear();
  });

  it('streams a CSV download for a UTC day range (the end day included)', async () => {
    const res = await get('?format=csv&from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/filename="audit-log-.*\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('a,b\r\n1,2\r\n');
    expect(openAuditExport).toHaveBeenCalledWith({ stub: true }, actor, {
      format: 'csv',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
    });
    expect(finish).toHaveBeenCalled();
  });

  it('serves JSON Lines', async () => {
    const res = await get('?format=json&from=&to=');
    expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/\.jsonl"$/);
  });

  it('answers 401 without a session and 400 for a bad query', async () => {
    currentActor.mockResolvedValue(null);
    expect((await get('?format=csv')).status).toBe(401);
    currentActor.mockResolvedValue(actor);
    for (const q of ['', '?format=xml', '?format=csv&from=2026-13-40', '?format=csv&x=1']) {
      expect((await get(q)).status).toBe(400);
    }
    expect(openAuditExport).not.toHaveBeenCalled();
  });

  it('answers 403 for other roles and 429 when throttled', async () => {
    openAuditExport.mockResolvedValueOnce({ ok: false, code: 'forbidden_role' });
    expect((await get('?format=csv')).status).toBe(403);
    for (const code of ['export_in_progress', 'export_rate_limited']) {
      openAuditExport.mockResolvedValueOnce({ ok: false, code });
      const res = await get('?format=csv');
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: code });
    }
  });
});
