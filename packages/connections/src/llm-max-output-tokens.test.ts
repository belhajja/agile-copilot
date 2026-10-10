import { auditLog } from '@agile/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  createLlmConnection,
  type LlmDeps,
  listLlmConnections,
  loadDefaultLlm,
  setLlmMaxOutputTokens,
} from './llm-connections';
import { keyring, manager, owner, startHarness, viewer } from './test-helpers';

const config = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5-5',
  apiKey: 'sk-ant-secret-1234',
};

describe('LLM answer budget (max output tokens)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: LlmDeps;
  let id = '';
  let probes = 0;
  beforeAll(async () => {
    h = await startHarness();
    deps = {
      db: h.db,
      keyring,
      allowedPrivateHosts: [],
      probe: async () => {
        probes++;
        return { ok: true, latencyMs: 1 };
      },
    };
    const r = await createLlmConnection(deps, owner(), { label: 'Claude', config });
    if (!r.ok) throw new Error(r.code);
    id = r.connection.id;
  });
  afterAll(async () => h?.stop());

  it('is unset by default', async () => {
    expect((await listLlmConnections(deps, 'org_a'))[0]?.maxOutputTokens).toBeNull();
    expect((await loadDefaultLlm(deps, 'org_a'))?.maxOutputTokens).toBeNull();
  });

  it('is stored, returned with the model and audited; null clears it', async () => {
    expect(await setLlmMaxOutputTokens(deps, owner(), id, 32_000)).toEqual({ ok: true });
    expect(await loadDefaultLlm(deps, 'org_a')).toMatchObject({ id, maxOutputTokens: 32_000 });
    expect((await listLlmConnections(deps, 'org_a'))[0]?.maxOutputTokens).toBe(32_000);
    expect(await setLlmMaxOutputTokens(deps, owner(), id, null)).toEqual({ ok: true });
    expect((await loadDefaultLlm(deps, 'org_a'))?.maxOutputTokens).toBeNull();
    const audit = await h.rawDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'llm_connection.max_output_tokens_changed'));
    expect(audit.map((a) => a.metadata)).toEqual([
      { maxOutputTokens: 32_000 },
      { maxOutputTokens: null },
    ]);
  });

  it('refuses values outside 1 000–64 000, fractions and non-admins', async () => {
    for (const bad of [999, 64_001, 2_000.5, -1]) {
      expect(await setLlmMaxOutputTokens(deps, owner(), id, bad)).toMatchObject({
        ok: false,
        code: 'invalid_input',
      });
    }
    for (const actor of [viewer(), manager()]) {
      await expect(setLlmMaxOutputTokens(deps, actor, id, 8_000)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await setLlmMaxOutputTokens(deps, owner('org_b'), id, 8_000)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('can be set when the connection is created, and is checked before the probe', async () => {
    const created = await createLlmConnection(deps, owner('org_c'), {
      label: 'Qwen',
      config,
      maxOutputTokens: 48_000,
    });
    expect(created).toMatchObject({ ok: true, connection: { maxOutputTokens: 48_000 } });
    const before = probes;
    expect(
      await createLlmConnection(deps, owner('org_c'), {
        label: 'Too much',
        config,
        maxOutputTokens: 100_000,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(probes).toBe(before);
  });
});
