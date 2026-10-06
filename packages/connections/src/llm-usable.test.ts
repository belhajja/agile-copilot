import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLlmConnection,
  type LlmDeps,
  loadUsableLlm,
  retestLlmConnection,
} from './llm-connections';
import { keyring, owner, startHarness } from './test-helpers';

describe('a model picked for a conversation (loadUsableLlm)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let failing = false;
  let deps: LlmDeps;
  beforeAll(async () => {
    h = await startHarness();
    deps = {
      db: h.db,
      keyring,
      allowedPrivateHosts: [],
      probe: async () =>
        failing
          ? { ok: false, code: 'forbidden', message: 'no access' }
          : { ok: true, latencyMs: 1 },
    };
  });
  afterAll(async () => h?.stop());

  const add = async (model: string) => {
    const r = await createLlmConnection(deps, owner(), {
      label: model,
      config: { provider: 'anthropic', model, apiKey: `sk-ant-${model}-1234` },
    });
    if (!r.ok) throw new Error(r.code);
    return r.connection.id;
  };

  it('loads a working connection of the workspace', async () => {
    const id = await add('good-model');
    expect(await loadUsableLlm(deps, 'org_a', id)).toMatchObject({
      id,
      config: { model: 'good-model' },
    });
  });

  it('refuses a connection of another workspace or an unknown id', async () => {
    const id = await add('mine');
    expect(await loadUsableLlm(deps, 'org_b', id)).toBeNull();
    expect(await loadUsableLlm(deps, 'org_a', '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('refuses a connection that fails its check (the caller falls back to the default)', async () => {
    const id = await add('revoked-model');
    failing = true;
    try {
      await retestLlmConnection(deps, owner(), id);
    } finally {
      failing = false;
    }
    expect(await loadUsableLlm(deps, 'org_a', id)).toBeNull();
  });
});
