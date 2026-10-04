import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const actor = { orgId: 'org_1', userId: 'user_1', roles: ['viewer'] };

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/server/context', () => ({
  requireActor: async () => actor,
  services: () => ({ db: { stub: true } }),
}));
vi.mock('@/server/mcp', () => ({ mcpDeps: () => ({ db: { stub: true } }) }));

const createMcpToken = vi.fn();
const revokeMcpToken = vi.fn();
vi.mock('@agile/mcp-gateway', async () => {
  class TokenError extends Error {
    override name = 'TokenError';
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    TokenError,
    createMcpToken: (...a: unknown[]) => createMcpToken(...a),
    revokeMcpToken: (...a: unknown[]) => revokeMcpToken(...a),
  };
});

const { TokenError } = (await import('@agile/mcp-gateway')) as unknown as {
  TokenError: new (code: string) => Error;
};
const { createTokenAction, revokeTokenAction } = await import('./actions');

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('MCP token actions', () => {
  beforeEach(() => {
    createMcpToken.mockReset();
    revokeMcpToken.mockReset();
    revalidatePath.mockClear();
  });

  it('creates a token for the caller and returns it once', async () => {
    createMcpToken.mockResolvedValue({
      id: ID,
      token: 'acp_org_1.secret',
      prefix: 'acp_org_1.secr',
    });
    const state = await createTokenAction(
      { status: 'idle' },
      form({ name: 'Claude Desktop', expiresInDays: '30' }),
    );
    expect(state).toEqual({ status: 'created', token: 'acp_org_1.secret' });
    expect(createMcpToken).toHaveBeenCalledWith(expect.anything(), actor, {
      name: 'Claude Desktop',
      expiresInDays: 30,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/mcp');
  });

  it('returns the refusal code instead of failing silently', async () => {
    createMcpToken.mockRejectedValue(new TokenError('mcp_disabled'));
    expect(await createTokenAction({ status: 'idle' }, form({ name: 'x' }))).toEqual({
      status: 'error',
      code: 'mcp_disabled',
    });
  });

  it('reports a revocation, or why it did not happen', async () => {
    revokeMcpToken.mockResolvedValue(undefined);
    expect(await revokeTokenAction(ID)).toEqual({ ok: true });
    expect(revokeMcpToken).toHaveBeenCalledWith({ stub: true }, actor, ID);

    revokeMcpToken.mockRejectedValue(new TokenError('not_found'));
    expect(await revokeTokenAction(ID)).toEqual({ ok: false, code: 'not_found' });
  });

  it('lets unexpected failures surface', async () => {
    revokeMcpToken.mockRejectedValue(new Error('boom'));
    await expect(revokeTokenAction(ID)).rejects.toThrow('boom');
  });
});
