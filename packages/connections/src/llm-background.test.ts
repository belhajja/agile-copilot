import { auditLog } from '@agile/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  createLlmConnection,
  deleteLlmConnection,
  type LlmDeps,
  listLlmConnections,
  loadBackgroundLlm,
  loadDefaultLlm,
  setBackgroundLlmConnection,
} from './llm-connections';
import { keyring, manager, owner, startHarness, viewer } from './test-helpers';

describe('background model ("cheap model" for skill runs)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: LlmDeps;
  let main = '';
  let cheap = '';
  beforeAll(async () => {
    h = await startHarness();
    deps = {
      db: h.db,
      keyring,
      allowedPrivateHosts: [],
      probe: async () => ({ ok: true, latencyMs: 1 }),
    };
    const add = async (label: string, model: string) => {
      const r = await createLlmConnection(deps, owner(), {
        label,
        config: { provider: 'anthropic', model, apiKey: `sk-ant-${model}-1234` },
      });
      if (!r.ok) throw new Error(r.code);
      return r.connection.id;
    };
    main = await add('Main', 'big-model');
    cheap = await add('Cheap', 'small-model');
  });
  afterAll(async () => h?.stop());

  it('falls back to the default model until one is chosen', async () => {
    expect((await loadDefaultLlm(deps, 'org_a'))?.id).toBe(main);
    expect((await loadBackgroundLlm(deps, 'org_a'))?.id).toBe(main);
  });

  it('uses the chosen model for background runs, without changing the default', async () => {
    expect(await setBackgroundLlmConnection(deps, owner(), cheap)).toEqual({ ok: true });
    expect(await loadBackgroundLlm(deps, 'org_a')).toMatchObject({
      id: cheap,
      config: { model: 'small-model', apiKey: 'sk-ant-small-model-1234' },
    });
    expect((await loadDefaultLlm(deps, 'org_a'))?.id).toBe(main);
    const views = await listLlmConnections(deps, 'org_a');
    expect(views.map((v) => [v.label, v.isDefault, v.isBackground])).toEqual([
      ['Cheap', false, true],
      ['Main', true, false],
    ]);
    // Choosing again moves the flag (one per workspace).
    expect(await setBackgroundLlmConnection(deps, owner(), main)).toEqual({ ok: true });
    expect((await loadBackgroundLlm(deps, 'org_a'))?.id).toBe(main);
    expect(await setBackgroundLlmConnection(deps, owner(), cheap)).toEqual({ ok: true });
  });

  it('is cleared by choosing none, or by deleting the connection', async () => {
    expect(await setBackgroundLlmConnection(deps, owner(), null)).toEqual({ ok: true });
    expect((await loadBackgroundLlm(deps, 'org_a'))?.id).toBe(main);
    await setBackgroundLlmConnection(deps, owner(), cheap);
    await deleteLlmConnection(deps, owner(), cheap);
    expect((await loadBackgroundLlm(deps, 'org_a'))?.id).toBe(main);
  });

  it('is for owners and admins, within their workspace', async () => {
    for (const actor of [viewer(), manager()]) {
      await expect(setBackgroundLlmConnection(deps, actor, main)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await setBackgroundLlmConnection(deps, owner('org_b'), main)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    const audit = await h.rawDb
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, 'llm_connection.background_changed'));
    expect(audit.length).toBe(5);
  });
});
