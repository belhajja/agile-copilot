import { llmConnections } from '@agile/db';
import type { LlmConfig } from '@agile/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLlmConnection,
  deleteLlmConnection,
  type LlmDeps,
  listLlmConnections,
  loadDefaultLlmConfig,
  setDefaultLlmConnection,
} from './llm-connections';
import { keyring, owner, startHarness } from './test-helpers';

const anthropic = (apiKey = 'sk-ant-api03-secretvalue-WXYZ'): LlmConfig => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey,
});

describe('llm connections', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: LlmDeps;

  beforeAll(async () => {
    h = await startHarness();
    deps = {
      db: h.db,
      keyring,
      allowedPrivateHosts: [],
      probe: async () => ({ ok: true, latencyMs: 5 }),
    };
  });
  afterAll(async () => h?.stop());

  it('makes the first connection the default and shows only a key hint', async () => {
    const r = await createLlmConnection(deps, owner(), { label: 'Claude', config: anthropic() });
    expect(r).toMatchObject({
      ok: true,
      connection: { isDefault: true, keyHint: '…WXYZ', status: 'ok' },
    });
    expect(JSON.stringify(await listLlmConnections(deps, 'org_a'))).not.toContain('secretvalue');
    const [raw] = await h.rawDb.select().from(llmConnections);
    expect(raw?.secret).not.toContain('secretvalue');
  });

  it('switches the default atomically', async () => {
    const r = await createLlmConnection(deps, owner(), {
      label: 'Second',
      config: anthropic('sk-2-ABCD'),
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.connection.isDefault).toBe(false);
    expect(await setDefaultLlmConnection(deps, owner(), r.connection.id)).toEqual({ ok: true });
    const list = await listLlmConnections(deps, 'org_a');
    expect(list.filter((c) => c.isDefault).map((c) => c.label)).toEqual(['Second']);
    expect(await loadDefaultLlmConfig(deps, 'org_a')).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-2-ABCD',
    });
  });

  it('does not save a key that fails the probe', async () => {
    const failing: LlmDeps = {
      ...deps,
      probe: async () => ({ ok: false, code: 'unauthorized', message: 'x' }),
    };
    expect(
      await createLlmConnection(failing, owner(), { label: 'Bad', config: anthropic() }),
    ).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
  });

  it('rejects an invalid Azure resource name without saving or calling the network', async () => {
    const before = (await listLlmConnections(deps, 'org_a')).length;
    const { probe: _omit, ...real } = deps;
    const config: LlmConfig = {
      provider: 'azure',
      model: 'gpt-4o',
      apiKey: 'azure-key-1234',
      resourceName: 'evil.com/#',
    };
    expect(await createLlmConnection(real, owner(), { label: 'Evil', config })).toEqual({
      ok: false,
      code: 'provider_error',
      message: 'Invalid Azure resource name.',
    });
    expect((await listLlmConnections(deps, 'org_a')).length).toBe(before);
  });

  it('blocks private OpenAI-compatible endpoints unless allowlisted', async () => {
    const config: LlmConfig = {
      provider: 'openai_compatible',
      model: 'llama3.1',
      baseUrl: 'http://127.0.0.1:11434/v1',
    };
    expect(await createLlmConnection(deps, owner(), { label: 'Ollama', config })).toMatchObject({
      ok: false,
      code: 'blocked_url',
    });
    const allowed = { ...deps, allowedPrivateHosts: ['127.0.0.1'] };
    expect(await createLlmConnection(allowed, owner(), { label: 'Ollama', config })).toMatchObject({
      ok: true,
    });
  });

  it('is invisible to other orgs and deleting the default leaves none', async () => {
    expect(await listLlmConnections(deps, 'org_b')).toEqual([]);
    expect(await loadDefaultLlmConfig(deps, 'org_b')).toBeNull();
    const def = (await listLlmConnections(deps, 'org_a')).find((c) => c.isDefault);
    expect(await deleteLlmConnection(deps, owner('org_b'), def?.id ?? '')).toMatchObject({
      code: 'not_found',
    });
    expect(await deleteLlmConnection(deps, owner(), def?.id ?? '')).toEqual({ ok: true });
    expect(await loadDefaultLlmConfig(deps, 'org_a')).toBeNull();
  });
});
