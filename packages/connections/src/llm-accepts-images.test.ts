import { auditLog } from '@agile/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  createLlmConnection,
  type LlmDeps,
  listLlmConnections,
  loadDefaultLlm,
  setLlmAcceptsImages,
} from './llm-connections';
import { keyring, manager, owner, startHarness, viewer } from './test-helpers';

const config = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5-5',
  apiKey: 'sk-ant-secret-1234',
};

describe('LLM image input (accepts_images)', () => {
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
    const r = await createLlmConnection(deps, owner(), { label: 'Claude', config });
    if (!r.ok) throw new Error(r.code);
    id = r.connection.id;
  });
  afterAll(async () => h?.stop());

  it('is off by default', async () => {
    expect((await listLlmConnections(deps, 'org_a'))[0]?.acceptsImages).toBe(false);
    expect((await loadDefaultLlm(deps, 'org_a'))?.acceptsImages).toBe(false);
  });

  it('is stored, returned with the model and audited', async () => {
    expect(await setLlmAcceptsImages(deps, owner(), id, true)).toEqual({ ok: true });
    expect(await loadDefaultLlm(deps, 'org_a')).toMatchObject({ id, acceptsImages: true });
    expect((await listLlmConnections(deps, 'org_a'))[0]?.acceptsImages).toBe(true);
    expect(await setLlmAcceptsImages(deps, owner(), id, false)).toEqual({ ok: true });
    expect((await loadDefaultLlm(deps, 'org_a'))?.acceptsImages).toBe(false);
    const audit = await h.rawDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'llm_connection.accepts_images_changed'));
    expect(audit.map((a) => a.metadata)).toEqual([
      { acceptsImages: true },
      { acceptsImages: false },
    ]);
  });

  it('refuses non-admins and connections of another workspace', async () => {
    for (const actor of [viewer(), manager()]) {
      await expect(setLlmAcceptsImages(deps, actor, id, true)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await setLlmAcceptsImages(deps, owner('org_b'), id, true)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect((await loadDefaultLlm(deps, 'org_a'))?.acceptsImages).toBe(false);
  });

  it('can be set when the connection is created', async () => {
    const created = await createLlmConnection(deps, owner('org_c'), {
      label: 'Vision',
      config,
      acceptsImages: true,
    });
    expect(created).toMatchObject({ ok: true, connection: { acceptsImages: true } });
  });
});
