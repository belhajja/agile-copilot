import { beforeEach, describe, expect, it, vi } from 'vitest';

const owner = { orgId: 'org_a', userId: 'user_1', roles: ['owner'] };
const currentActor = vi.fn(async (_headers: Headers): Promise<typeof owner | null> => owner);
const db = { stub: true };
vi.mock('@/server/context', () => ({
  currentActor: (headers: Headers) => currentActor(headers),
  services: () => ({ db }),
}));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const loadAttachment = vi.fn();
vi.mock('@agile/agent', () => ({
  loadAttachment: (...args: unknown[]) => loadAttachment(...args),
}));

const { GET } = await import('./route');

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const get = (id = ID, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost:3200/api/agent/attachments/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/agent/attachments/[id]', () => {
  beforeEach(() => {
    currentActor.mockResolvedValue(owner);
    loadAttachment.mockReset();
    loadAttachment.mockResolvedValue({ mediaType: 'image/png', bytes: png, sha256: 'abc' });
  });

  it('serves the image to the signed-in owner of its conversation, as stored', async () => {
    const res = await get();
    expect(loadAttachment).toHaveBeenCalledWith(db, owner, ID);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, max-age=86400, immutable',
      etag: '"abc"',
      'content-length': String(png.length),
    });
  });

  it('answers 304 when the browser already has it', async () => {
    const res = await get(ID, { 'if-none-match': '"abc"' });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('answers 404 for anyone else, or an unknown id, without saying which', async () => {
    loadAttachment.mockResolvedValue(null);
    const res = await get('not-a-uuid');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 401 without a session, before any lookup', async () => {
    currentActor.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(loadAttachment).not.toHaveBeenCalled();
  });
});
