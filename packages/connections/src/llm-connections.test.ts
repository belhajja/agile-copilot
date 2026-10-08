import { auditLog, llmConnections } from '@agile/db';
import type { LlmConfig } from '@agile/llm';
import { startMockOpenAI } from '@agile/llm/testing';
import { desc, eq } from 'drizzle-orm';
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
      detail: { reason: 'private_address', host: '127.0.0.1' },
    });
    const allowed = { ...deps, allowedPrivateHosts: ['127.0.0.1'] };
    expect(await createLlmConnection(allowed, owner(), { label: 'Ollama', config })).toMatchObject({
      ok: true,
    });
  });

  it('refuses plain http to a public endpoint before sending the key', async () => {
    const mock = await startMockOpenAI({ validKey: 'k' });
    try {
      const config: LlmConfig = {
        provider: 'openai_compatible',
        model: 'mock',
        baseUrl: mock.baseUrl.replace('127.0.0.1', 'llm.example.com'),
        apiKey: 'k',
      };
      const publicDns: LlmDeps = { ...deps, resolve: async () => ['93.184.216.34'] };
      expect(
        await createLlmConnection(publicDns, owner(), { label: 'Plain', config }),
      ).toMatchObject({ ok: false, code: 'insecure_transport' });
      expect(mock.requests).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it('pins the probe to the checked address: a rebinding host never reaches the LLM', async () => {
    const mock = await startMockOpenAI({ validKey: 'k' });
    try {
      let calls = 0;
      const rebinding: LlmDeps = {
        db: h.db,
        keyring,
        allowedPrivateHosts: [],
        // Public for the URL check, then the local mock (DNS rebinding) for the connection.
        resolve: async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']),
      };
      const config: LlmConfig = {
        provider: 'openai_compatible',
        model: 'mock',
        baseUrl: mock.baseUrl.replace('http://127.0.0.1', 'https://llm.rebind.example'),
        apiKey: 'k',
      };
      const result = await createLlmConnection(rebinding, owner(), { label: 'Rebind', config });
      expect(result).toMatchObject({ ok: false, code: 'blocked_url' });
      expect(mock.requests).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it('race: concurrent creates for a fresh org leave exactly one default', async () => {
    const o = owner('org_race');
    const rs = await Promise.all([
      createLlmConnection(deps, o, { label: 'A', config: anthropic('sk-race-A-1234') }),
      createLlmConnection(deps, o, { label: 'B', config: anthropic('sk-race-B-5678') }),
    ]);
    expect(rs.map((r) => r.ok)).toEqual([true, true]);
    expect((await listLlmConnections(deps, 'org_race')).filter((c) => c.isDefault)).toHaveLength(1);
  });

  it('race: concurrent setDefault calls leave exactly one default', async () => {
    const o = owner('org_race');
    const ids = (await listLlmConnections(deps, 'org_race')).map((c) => c.id);
    const rs = await Promise.all(ids.map((id) => setDefaultLlmConnection(deps, o, id)));
    expect(rs).toEqual([{ ok: true }, { ok: true }]);
    expect((await listLlmConnections(deps, 'org_race')).filter((c) => c.isDefault)).toHaveLength(1);
  });

  it('is invisible to other orgs; deleting the default promotes the most recent remaining one', async () => {
    expect(await listLlmConnections(deps, 'org_b')).toEqual([]);
    expect(await loadDefaultLlmConfig(deps, 'org_b')).toBeNull();
    const def = (await listLlmConnections(deps, 'org_a')).find((c) => c.isDefault);
    expect(def?.label).toBe('Second');
    expect(await deleteLlmConnection(deps, owner('org_b'), def?.id ?? '')).toMatchObject({
      code: 'not_found',
    });
    expect(await deleteLlmConnection(deps, owner(), def?.id ?? '')).toEqual({ ok: true });
    // 'Ollama' (added after 'Claude') is now the most recent remaining connection.
    const after = await listLlmConnections(deps, 'org_a');
    expect(after.filter((c) => c.isDefault).map((c) => c.label)).toEqual(['Ollama']);
    expect(await loadDefaultLlmConfig(deps, 'org_a')).toMatchObject({
      provider: 'openai_compatible',
    });
    const [audit] = await h.rawDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'llm_connection.default_changed'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.metadata).toEqual({ reason: 'previous_default_deleted' });
  });

  it('deleting a non-default connection keeps the default; deleting the last leaves none', async () => {
    const claude = (await listLlmConnections(deps, 'org_a')).find((c) => c.label === 'Claude');
    expect(await deleteLlmConnection(deps, owner(), claude?.id ?? '')).toEqual({ ok: true });
    const [only] = await listLlmConnections(deps, 'org_a');
    expect(only).toMatchObject({ label: 'Ollama', isDefault: true });
    expect(await deleteLlmConnection(deps, owner(), only?.id ?? '')).toEqual({ ok: true });
    expect(await listLlmConnections(deps, 'org_a')).toEqual([]);
    expect(await loadDefaultLlmConfig(deps, 'org_a')).toBeNull();
  });
});
