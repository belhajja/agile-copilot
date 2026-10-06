import { auditLog, llmConnections } from '@agile/db';
import type { LlmConfig } from '@agile/llm';
import { startMockOpenAI } from '@agile/llm/testing';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  changeLlmModel,
  createLlmConnection,
  deleteLlmConnection,
  type LlmDeps,
  listLlmModelsForConnection,
} from './llm-connections';
import { keyring, manager, owner, startHarness, viewer } from './test-helpers';

const anthropic = (apiKey = 'sk-ant-api03-secretvalue-WXYZ'): LlmConfig => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey,
});

describe('listing and changing a connection’s model', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: LlmDeps;
  let id = '';

  beforeAll(async () => {
    h = await startHarness();
    deps = {
      db: h.db,
      keyring,
      allowedPrivateHosts: [],
      probe: async () => ({ ok: true, latencyMs: 1 }),
    };
    const r = await createLlmConnection(deps, owner(), { label: 'Claude', config: anthropic() });
    if (!r.ok) throw new Error(r.code);
    id = r.connection.id;
  });
  afterAll(async () => h?.stop());

  it('lists the models the stored key can use, without ever returning the key', async () => {
    const withList: LlmDeps = {
      ...deps,
      listModels: async () => ({ ok: true, models: ['claude-haiku-5', 'claude-sonnet-5-5'] }),
    };
    const r = await listLlmModelsForConnection(withList, owner(), id);
    expect(r).toEqual({ ok: true, models: ['claude-haiku-5', 'claude-sonnet-5-5'] });
    expect(JSON.stringify(r)).not.toContain('secretvalue');
  });

  it('is for owners and admins, within their workspace', async () => {
    for (const actor of [viewer(), manager()]) {
      await expect(listLlmModelsForConnection(deps, actor, id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await listLlmModelsForConnection(deps, owner('org_b'), id)).toMatchObject({
      code: 'not_found',
    });
  });

  it('reports why the key could not list models (e.g. unauthorized)', async () => {
    const failing: LlmDeps = {
      ...deps,
      listModels: async () => ({ ok: false, code: 'unauthorized', message: 'nope' }),
    };
    expect(await listLlmModelsForConnection(failing, owner(), id)).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'nope',
    });
  });

  it('lists an OpenAI-compatible connection’s models over the real network', async () => {
    const mock = await startMockOpenAI({ validKey: 'k', models: ['llama3.1', 'qwen3.5-122b'] });
    try {
      const allowed: LlmDeps = { ...deps, allowedPrivateHosts: ['127.0.0.1'] };
      const compat = await createLlmConnection(allowed, owner(), {
        label: 'Local',
        config: {
          provider: 'openai_compatible',
          model: 'llama3.1',
          baseUrl: mock.baseUrl,
          apiKey: 'k',
        },
      });
      if (!compat.ok) throw new Error(compat.code);
      const { listModels: _omit, ...real } = allowed;
      const r = await listLlmModelsForConnection(real, owner(), compat.connection.id);
      expect(r).toEqual({ ok: true, models: ['llama3.1', 'qwen3.5-122b'] });
    } finally {
      await mock.close();
    }
  });

  it('changes the model, retests the connection, and audits the change (no key)', async () => {
    const r = await changeLlmModel(deps, owner(), id, 'claude-haiku-5');
    expect(r).toMatchObject({ ok: true, connection: { model: 'claude-haiku-5', status: 'ok' } });
    expect(JSON.stringify(r)).not.toContain('secretvalue');
    const [raw] = await h.rawDb.select().from(llmConnections).where(eq(llmConnections.id, id));
    expect(raw?.model).toBe('claude-haiku-5');
    expect(raw?.secret).not.toContain('secretvalue');
    const [audit] = await h.rawDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'llm_connection.model_changed'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.metadata).toEqual({ from: 'claude-sonnet-5-5', to: 'claude-haiku-5' });
    expect(JSON.stringify(audit)).not.toContain('secretvalue');
  });

  it('keeps the connection but stores the error status when the new model fails its test', async () => {
    const failing: LlmDeps = {
      ...deps,
      probe: async () => ({ ok: false, code: 'model_not_found', message: 'x' }),
    };
    const r = await changeLlmModel(failing, owner(), id, 'does-not-exist');
    expect(r).toMatchObject({
      ok: true,
      connection: { model: 'does-not-exist', status: 'error', lastError: 'model_not_found' },
    });
  });

  it('rejects an empty or too-long model string without touching the connection', async () => {
    const [before] = await h.rawDb.select().from(llmConnections).where(eq(llmConnections.id, id));
    expect(await changeLlmModel(deps, owner(), id, '  ')).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(await changeLlmModel(deps, owner(), id, 'x'.repeat(201))).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    const [after] = await h.rawDb.select().from(llmConnections).where(eq(llmConnections.id, id));
    expect(after?.model).toBe(before?.model);
  });

  it('is for owners and admins, and is scoped to the workspace', async () => {
    for (const actor of [viewer(), manager()]) {
      await expect(changeLlmModel(deps, actor, id, 'claude-sonnet-5-5')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await changeLlmModel(deps, owner('org_b'), id, 'claude-sonnet-5-5')).toMatchObject({
      code: 'not_found',
    });
  });

  it('does not audit a model change when the connection was deleted mid-flight', async () => {
    const racy = await createLlmConnection(deps, owner(), {
      label: 'Racy',
      config: anthropic('sk-ant-racy-value-1234'),
    });
    if (!racy.ok) throw new Error(racy.code);
    const racyId = racy.connection.id;
    // The retest (probe) runs between the read and the update: delete the row from under it here.
    const deletingProbe: LlmDeps = {
      ...deps,
      probe: async () => {
        await deleteLlmConnection(deps, owner(), racyId);
        return { ok: true, latencyMs: 1 };
      },
    };
    const r = await changeLlmModel(deletingProbe, owner(), racyId, 'claude-haiku-5');
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    const auditRows = await h.rawDb.select().from(auditLog).where(eq(auditLog.targetId, racyId));
    expect(auditRows.some((a) => a.action === 'llm_connection.model_changed')).toBe(false);
  });

  it('leaves label, prices and default/background flags untouched', async () => {
    const before = await h.rawDb.select().from(llmConnections).where(eq(llmConnections.id, id));
    await changeLlmModel(deps, owner(), id, 'claude-sonnet-5-5');
    const after = await h.rawDb.select().from(llmConnections).where(eq(llmConnections.id, id));
    expect(after[0]?.label).toBe(before[0]?.label);
    expect(after[0]?.isDefault).toBe(before[0]?.isDefault);
    expect(after[0]?.isBackground).toBe(before[0]?.isBackground);
    expect(after[0]?.inputPriceMicros).toBe(before[0]?.inputPriceMicros);
    expect(after[0]?.outputPriceMicros).toBe(before[0]?.outputPriceMicros);
  });
});
