import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

let actor: { orgId: string; userId: string; roles: string[] } = {
  orgId: 'org_1',
  userId: 'user_1',
  roles: ['owner'],
};
const deps = { db: { stub: true }, keyring: { stub: true }, allowedPrivateHosts: ['allowed.test'] };
vi.mock('@/server/context', () => ({
  requireActor: async () => actor,
  connectionDeps: () => deps,
}));

const listLlmModelsForConnection = vi.fn();
const changeLlmModel = vi.fn();
vi.mock('@agile/connections', async (importActual) => {
  const actual = await importActual<typeof import('@agile/connections')>();
  return {
    ...actual,
    createLlmConnection: vi.fn(),
    deleteLlmConnection: vi.fn(),
    retestLlmConnection: vi.fn(),
    setBackgroundLlmConnection: vi.fn(),
    setDefaultLlmConnection: vi.fn(),
    setLlmConnectionPrices: vi.fn(),
    listLlmModelsForConnection: (...a: unknown[]) => listLlmModelsForConnection(...a),
    changeLlmModel: (...a: unknown[]) => changeLlmModel(...a),
  };
});
const { ForbiddenError } = await import('@agile/connections');

const listModels = vi.fn();
vi.mock('@agile/llm', () => ({ listModels: (...a: unknown[]) => listModels(...a) }));

const checkOutboundUrl = vi.fn();
const createOutboundFetch = vi.fn((..._a: unknown[]) => 'FETCH_STUB');
vi.mock('@agile/net', () => ({
  checkOutboundUrl: (...a: unknown[]) => checkOutboundUrl(...a),
  createOutboundFetch: (...a: unknown[]) => createOutboundFetch(...a),
}));

const { changeLlmModelAction, listModelsForConnectionAction, listModelsForNewConnectionAction } =
  await import('./actions');

const ID = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('listModelsForNewConnectionAction', () => {
  beforeEach(() => {
    actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
    listModels.mockReset();
    checkOutboundUrl.mockReset();
    createOutboundFetch.mockClear();
  });

  it('rejects an invalid form without calling the network', async () => {
    const r = await listModelsForNewConnectionAction(form({ provider: 'anthropic' }));
    expect(r).toEqual({ ok: false, code: 'invalid_input' });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('is for owners and admins', async () => {
    actor = { orgId: 'org_1', userId: 'user_1', roles: ['viewer'] };
    const r = await listModelsForNewConnectionAction(
      form({ provider: 'anthropic', apiKey: 'sk-x' }),
    );
    expect(r).toEqual({ ok: false, code: 'forbidden_role' });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('reports Azure as not supported without calling the network', async () => {
    const r = await listModelsForNewConnectionAction(
      form({ provider: 'azure', apiKey: 'sk-x', resourceName: 'res-1' }),
    );
    expect(r).toEqual({ ok: false, code: 'not_supported' });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('lists a fixed-host provider’s models', async () => {
    listModels.mockResolvedValue({ ok: true, models: ['claude-sonnet-5-5'] });
    const r = await listModelsForNewConnectionAction(
      form({ provider: 'anthropic', apiKey: 'sk-x' }),
    );
    expect(r).toEqual({ ok: true, models: ['claude-sonnet-5-5'] });
    expect(listModels).toHaveBeenCalledWith({ provider: 'anthropic', apiKey: 'sk-x' });
    expect(checkOutboundUrl).not.toHaveBeenCalled();
  });

  it('blocks a private openai_compatible base URL before calling listModels', async () => {
    checkOutboundUrl.mockResolvedValue({
      ok: false,
      code: 'private_address',
      reason: 'blocked',
      host: '127.0.0.1',
    });
    const r = await listModelsForNewConnectionAction(
      form({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1' }),
    );
    expect(r).toEqual({
      ok: false,
      code: 'blocked_url',
      reason: 'private_address',
      host: '127.0.0.1',
    });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('lists an openai_compatible server’s models through the pinned fetch', async () => {
    checkOutboundUrl.mockResolvedValue({ ok: true });
    listModels.mockResolvedValue({ ok: true, models: ['llama3.1'] });
    const r = await listModelsForNewConnectionAction(
      form({ provider: 'openai_compatible', baseUrl: 'http://ollama:11434/v1', apiKey: 'k' }),
    );
    expect(r).toEqual({ ok: true, models: ['llama3.1'] });
    expect(createOutboundFetch).toHaveBeenCalledWith({
      allowedPrivateHosts: deps.allowedPrivateHosts,
    });
    expect(listModels).toHaveBeenCalledWith(
      { provider: 'openai_compatible', baseUrl: 'http://ollama:11434/v1', apiKey: 'k' },
      { fetch: 'FETCH_STUB' },
    );
  });

  it('passes through a listModels failure code', async () => {
    listModels.mockResolvedValue({ ok: false, code: 'unauthorized', message: 'no' });
    const r = await listModelsForNewConnectionAction(
      form({ provider: 'anthropic', apiKey: 'sk-x' }),
    );
    expect(r).toEqual({ ok: false, code: 'unauthorized' });
  });
});

describe('listModelsForConnectionAction', () => {
  beforeEach(() => {
    actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
    listLlmModelsForConnection.mockReset();
  });

  it('rejects a non-UUID id without calling the service', async () => {
    expect(await listModelsForConnectionAction('not-a-uuid')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(listLlmModelsForConnection).not.toHaveBeenCalled();
  });

  it('returns the models for a valid id', async () => {
    listLlmModelsForConnection.mockResolvedValue({ ok: true, models: ['m1', 'm2'] });
    expect(await listModelsForConnectionAction(ID)).toEqual({ ok: true, models: ['m1', 'm2'] });
    expect(listLlmModelsForConnection).toHaveBeenCalledWith(deps, actor, ID);
  });

  it('maps a service failure, including a blocked_url detail', async () => {
    listLlmModelsForConnection.mockResolvedValue({
      ok: false,
      code: 'blocked_url',
      message: 'x',
      detail: { reason: 'private_address', host: 'h' },
    });
    expect(await listModelsForConnectionAction(ID)).toEqual({
      ok: false,
      code: 'blocked_url',
      reason: 'private_address',
      host: 'h',
    });
  });

  it('reports a role refusal', async () => {
    listLlmModelsForConnection.mockRejectedValue(new ForbiddenError('nope'));
    expect(await listModelsForConnectionAction(ID)).toEqual({ ok: false, code: 'forbidden_role' });
  });
});

describe('changeLlmModelAction', () => {
  beforeEach(() => {
    actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
    changeLlmModel.mockReset();
    revalidatePath.mockClear();
  });

  it('rejects a non-UUID id without calling the service', async () => {
    expect(await changeLlmModelAction('not-a-uuid', 'claude-sonnet-5-5')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(changeLlmModel).not.toHaveBeenCalled();
  });

  it('changes the model and revalidates the page', async () => {
    changeLlmModel.mockResolvedValue({ ok: true, connection: { id: ID } });
    expect(await changeLlmModelAction(ID, 'claude-sonnet-5-5')).toEqual({ ok: true });
    expect(changeLlmModel).toHaveBeenCalledWith(deps, actor, ID, 'claude-sonnet-5-5');
    expect(revalidatePath).toHaveBeenCalledWith('/settings/llm');
  });

  it('passes through a failure code without revalidating', async () => {
    changeLlmModel.mockResolvedValue({ ok: false, code: 'invalid_input', message: 'x' });
    expect(await changeLlmModelAction(ID, '')).toEqual({ ok: false, code: 'invalid_input' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('reports a role refusal', async () => {
    changeLlmModel.mockRejectedValue(new ForbiddenError('nope'));
    expect(await changeLlmModelAction(ID, 'claude-sonnet-5-5')).toEqual({
      ok: false,
      code: 'forbidden_role',
    });
  });
});
