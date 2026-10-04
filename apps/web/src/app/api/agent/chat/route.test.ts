import { beforeEach, describe, expect, it, vi } from 'vitest';

const owner = {
  orgId: 'org_a',
  userId: 'user_1',
  roles: ['owner'],
  user: { id: 'user_1', name: 'Pat', email: 'pat@example.com' },
};
const currentActor = vi.fn(async (_headers: Headers): Promise<typeof owner | null> => owner);
vi.mock('@/server/context', () => ({
  currentActor: (headers: Headers) => currentActor(headers),
  services: () => ({ env: { BETTER_AUTH_URL: 'http://localhost:3200' } }),
}));
vi.mock('@/server/agent', () => ({ agentDeps: () => ({ deps: 'stub' }) }));
const handleAgentRequest = vi.fn(async () => new Response('stream'));
vi.mock('@agile/agent', () => ({
  handleAgentRequest: (...args: unknown[]) => handleAgentRequest(...(args as [])),
}));

const { POST } = await import('./route');

// `headers` overrides the same-origin defaults; a null value removes the header.
const post = (body: unknown, headers: Record<string, string | null> = {}) => {
  const merged: Record<string, string | null> = {
    'content-type': 'application/json',
    origin: 'http://localhost:3200',
    ...headers,
  };
  const sent = Object.fromEntries(
    Object.entries(merged).filter((e): e is [string, string] => e[1] !== null),
  );
  return POST(
    new Request('http://localhost:3200/api/agent/chat', {
      method: 'POST',
      headers: sent,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
};

describe('POST /api/agent/chat', () => {
  beforeEach(() => {
    currentActor.mockResolvedValue(owner);
    handleAgentRequest.mockClear();
  });

  it('runs the turn for the signed-in member with the server-side actor', async () => {
    const res = await post({ conversationId: 'c', message: { id: 'm', text: 'hi' } });
    expect(await res.text()).toBe('stream');
    expect(handleAgentRequest).toHaveBeenCalledWith({ deps: 'stub' }, owner, {
      conversationId: 'c',
      message: { id: 'm', text: 'hi' },
    });
  });

  it('answers 401 without a session (no redirect to an HTML page)', async () => {
    currentActor.mockResolvedValue(null);
    const res = await post({});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('refuses cross-site requests', async () => {
    const res = await post({}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('refuses a request without Origin and without Sec-Fetch-Site', async () => {
    const res = await post({}, { origin: null });
    expect(res.status).toBe(403);
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('allows a request without Origin when the browser says Sec-Fetch-Site: same-origin', async () => {
    const res = await post(
      { conversationId: 'c' },
      { origin: null, 'sec-fetch-site': 'same-origin' },
    );
    expect(res.status).toBe(200);
    expect(handleAgentRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses Sec-Fetch-Site: cross-site, even with no Origin', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await post({}, { origin: null, 'sec-fetch-site': site });
      expect(res.status).toBe(403);
    }
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('refuses a wrong Origin even when Sec-Fetch-Site says same-origin', async () => {
    const res = await post({}, { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(403);
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('refuses a body above 64 KB with 413 before reading it', async () => {
    const res = await post('x', { 'content-length': String(64 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('stops reading a chunked body (no Content-Length) once it passes 64 KB', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await POST(
      new Request('http://localhost:3200/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3200' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(handleAgentRequest).not.toHaveBeenCalled();
  });

  it('counts bytes, not characters: 40 000 three-byte characters are over 64 KB', async () => {
    const res = await post(JSON.stringify({ text: '€'.repeat(40_000) }), {
      'content-length': null,
    });
    expect(res.status).toBe(413);
  });

  it('passes unparsable bodies on as null (the agent answers 400)', async () => {
    await post('{not json');
    expect(handleAgentRequest).toHaveBeenCalledWith({ deps: 'stub' }, owner, null);
  });
});
