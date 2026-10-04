import { auditLog } from '@agile/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  createLlmConnection,
  type LlmDeps,
  listLlmConnections,
  loadDefaultLlm,
  setLlmConnectionPrices,
} from './llm-connections';
import { keyring, manager, owner, startHarness, viewer } from './test-helpers';

describe('LLM prices (cost meter)', () => {
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
    const r = await createLlmConnection(deps, owner(), {
      label: 'Claude',
      config: { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-secret-1234' },
    });
    if (!r.ok) throw new Error(r.code);
    id = r.connection.id;
  });
  afterAll(async () => h?.stop());

  it('stores prices per million tokens and returns them with the default model', async () => {
    expect(
      await setLlmConnectionPrices(deps, owner(), id, {
        inputMicros: 3_000_000,
        outputMicros: 15_000_000,
      }),
    ).toEqual({ ok: true });
    expect(await loadDefaultLlm(deps, 'org_a')).toMatchObject({
      id,
      config: { provider: 'anthropic', apiKey: 'sk-ant-secret-1234' },
      prices: { inputMicros: 3_000_000, outputMicros: 15_000_000 },
    });
    expect((await listLlmConnections(deps, 'org_a'))[0]).toMatchObject({
      inputPriceMicros: 3_000_000,
      outputPriceMicros: 15_000_000,
    });
    const audit = await h.rawDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'llm_connection.prices_changed'));
    expect(audit[0]?.metadata).toEqual({ inputMicros: 3_000_000, outputMicros: 15_000_000 });
  });

  it('refuses negative, fractional or absurd prices and non-admins', async () => {
    for (const bad of [-1, 1.5, 2_000_000_000]) {
      expect(
        await setLlmConnectionPrices(deps, owner(), id, { inputMicros: bad, outputMicros: 1 }),
      ).toEqual({
        ok: false,
        code: 'invalid_price',
      });
    }
    for (const actor of [viewer(), manager()]) {
      await expect(
        setLlmConnectionPrices(deps, actor, id, { inputMicros: 1, outputMicros: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(
      await setLlmConnectionPrices(deps, owner('org_b'), id, { inputMicros: 1, outputMicros: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
