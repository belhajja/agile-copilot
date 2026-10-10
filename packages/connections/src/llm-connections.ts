import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@agile/crypto';
import { type Actor, llmConnections, recordAudit, type Tx, withOrg } from '@agile/db';
import {
  createLanguageModel,
  type LlmConfig,
  type LlmProbeResult,
  type LlmProvider,
  listModels,
  type ModelListResult,
  type ProbeFailureCode,
  probeModel,
} from '@agile/llm';
import { isMaxOutputTokens } from '@agile/llm/output-budget';
import { type BlockedUrlReason, checkOutboundUrl, createOutboundFetch } from '@agile/net';
import { and, desc, eq, ne, type SQL, sql } from 'drizzle-orm';
import { assertCanManage } from './actor';
import type { ConnectionDeps } from './jira-connections';
import { getOrgDek } from './vault';

export interface LlmDeps extends ConnectionDeps {
  probe?: (cfg: LlmConfig) => Promise<LlmProbeResult>;
  listModels?: (cfg: LlmConfig) => Promise<ModelListResult>;
}

export interface LlmConnectionView {
  id: string;
  label: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  azureResourceName: string | null;
  keyHint: string | null;
  isDefault: boolean;
  /** Used for background skill runs (the "cheap model"); none set = the default model. */
  isBackground: boolean;
  /** Price per million tokens in millionths of a currency unit (null = not set). */
  inputPriceMicros: number | null;
  outputPriceMicros: number | null;
  /** Output tokens per model call, reasoning included (null = the default). */
  maxOutputTokens: number | null;
  status: 'untested' | 'ok' | 'error';
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

export type LlmServiceFailure = {
  ok: false;
  code: ProbeFailureCode | 'not_supported' | 'blocked_url' | 'not_found' | 'invalid_input';
  message: string;
  detail?: { reason: BlockedUrlReason; host?: string };
};

const notFound: LlmServiceFailure = {
  ok: false,
  code: 'not_found',
  message: 'Connection not found.',
};
const secretContext = (id: string) => `llm_connection:${id}`;

const toView = (r: typeof llmConnections.$inferSelect): LlmConnectionView => ({
  id: r.id,
  label: r.label,
  provider: r.provider,
  model: r.model,
  baseUrl: r.baseUrl,
  azureResourceName: r.azureResourceName,
  keyHint: r.keyHint,
  isDefault: r.isDefault,
  isBackground: r.isBackground,
  inputPriceMicros: r.inputPriceMicros,
  outputPriceMicros: r.outputPriceMicros,
  maxOutputTokens: r.maxOutputTokens,
  status: r.status,
  lastError: r.lastError,
  lastCheckedAt: r.lastCheckedAt,
  createdAt: r.createdAt,
});

function trimConfig(c: LlmConfig): LlmConfig {
  const model = c.model.trim();
  switch (c.provider) {
    case 'openai_compatible':
      return {
        provider: c.provider,
        model,
        baseUrl: c.baseUrl.trim().replace(/\/+$/, ''),
        apiKey: c.apiKey?.trim() || undefined,
      };
    case 'azure':
      return {
        provider: c.provider,
        model,
        apiKey: c.apiKey.trim(),
        resourceName: c.resourceName.trim(),
      };
    default:
      return { provider: c.provider, model, apiKey: c.apiKey.trim() };
  }
}

const keyHintOf = (c: LlmConfig) => {
  const key = 'apiKey' in c ? c.apiKey : undefined;
  return key && key.length >= 8 ? `…${key.slice(-4)}` : null;
};

// Serialises default-connection changes per org; released at commit/rollback.
async function lockOrgDefaults(tx: Tx, orgId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`llm_default:${orgId}`}))`);
}

/**
 * The OpenAI-compatible base URL check, shared by probing and listing models: refuses a private
 * URL unless allowlisted, else hands back the DNS-pinned fetch to use for the real call (fixed
 * vendor hosts need neither check nor pin).
 */
async function checkedOutboundFetch(
  deps: LlmDeps,
  config: LlmConfig,
): Promise<{ ok: true; fetch?: typeof fetch } | LlmServiceFailure> {
  if (config.provider !== 'openai_compatible') return { ok: true };
  const check = await checkOutboundUrl(config.baseUrl, deps);
  if (!check.ok && check.code === 'insecure_transport') {
    return {
      ok: false,
      code: 'insecure_transport',
      message: 'Plain http is only allowed for internal hosts your administrator allowed.',
    };
  }
  if (!check.ok) {
    return {
      ok: false,
      code: 'blocked_url',
      message: check.reason,
      detail: { reason: check.code, host: check.host },
    };
  }
  return {
    ok: true,
    fetch: createOutboundFetch({
      allowedPrivateHosts: deps.allowedPrivateHosts,
      resolve: deps.resolve,
    }),
  };
}

async function probe(
  deps: LlmDeps,
  config: LlmConfig,
): Promise<LlmProbeResult | LlmServiceFailure> {
  const outbound = await checkedOutboundFetch(deps, config);
  if (!outbound.ok) return outbound;
  if (deps.probe) return deps.probe(config);
  let model: ReturnType<typeof createLanguageModel>;
  try {
    model = createLanguageModel(config, outbound.fetch ? { fetch: outbound.fetch } : {});
  } catch (e) {
    if (config.provider === 'azure' && e instanceof TypeError)
      return { ok: false, code: 'provider_error', message: 'Invalid Azure resource name.' };
    throw e;
  }
  return probeModel(model);
}

/** The models a key can use, for the "Load models" / "Change model" pickers. */
async function modelsFor(
  deps: LlmDeps,
  config: LlmConfig,
): Promise<{ ok: true; models: string[] } | LlmServiceFailure> {
  const outbound = await checkedOutboundFetch(deps, config);
  if (!outbound.ok) return outbound;
  const result = deps.listModels
    ? await deps.listModels(config)
    : await listModels(config, outbound.fetch ? { fetch: outbound.fetch } : {});
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true, models: result.models };
}

async function readConfig(
  tx: Tx,
  deps: LlmDeps,
  orgId: string,
  row: typeof llmConnections.$inferSelect,
) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return JSON.parse(decryptSecret(dek, secretContext(row.id), row.secret)) as LlmConfig;
}

export async function createLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  input: {
    label: string;
    config: LlmConfig;
    makeDefault?: boolean;
    /** Null or omitted: the default budget. */
    maxOutputTokens?: number | null;
  },
): Promise<{ ok: true; connection: LlmConnectionView } | LlmServiceFailure> {
  assertCanManage(actor);
  const maxOutputTokens = input.maxOutputTokens ?? null;
  if (maxOutputTokens !== null && !isMaxOutputTokens(maxOutputTokens)) {
    return { ok: false, code: 'invalid_input', message: 'Invalid maximum answer length.' };
  }
  const config = trimConfig(input.config);
  const result = await probe(deps, config);
  if (!result.ok) return result;

  const id = randomUUID();
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    await lockOrgDefaults(tx, actor.orgId);
    const existingDefault = await tx
      .select({ id: llmConnections.id })
      .from(llmConnections)
      .where(eq(llmConnections.isDefault, true))
      .limit(1);
    const isDefault = input.makeDefault === true || existingDefault.length === 0;
    if (isDefault)
      await tx
        .update(llmConnections)
        .set({ isDefault: false })
        .where(eq(llmConnections.isDefault, true));
    const dek = await getOrgDek(tx, deps.keyring, actor.orgId);
    const [inserted] = await tx
      .insert(llmConnections)
      .values({
        id,
        orgId: actor.orgId,
        label: input.label.trim(),
        provider: config.provider,
        model: config.model,
        baseUrl: config.provider === 'openai_compatible' ? config.baseUrl : null,
        azureResourceName: config.provider === 'azure' ? config.resourceName : null,
        keyHint: keyHintOf(config),
        secret: encryptSecret(dek, secretContext(id), JSON.stringify(config)),
        isDefault,
        maxOutputTokens,
        status: 'ok',
        lastCheckedAt: new Date(),
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.created',
      targetType: 'llm_connection',
      targetId: id,
      metadata: {
        provider: config.provider,
        model: config.model,
        isDefault,
        ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
      },
    });
    return inserted;
  });
  if (!row) throw new Error('Insert returned no row');
  return { ok: true, connection: toView(row) };
}

export async function listLlmConnections(
  deps: LlmDeps,
  orgId: string,
): Promise<LlmConnectionView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(llmConnections).orderBy(desc(llmConnections.createdAt)),
  );
  return rows.map(toView);
}

export async function setDefaultLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | LlmServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    await lockOrgDefaults(tx, actor.orgId);
    const [target] = await tx
      .select({ id: llmConnections.id })
      .from(llmConnections)
      .where(eq(llmConnections.id, id));
    if (!target) return notFound;
    await tx
      .update(llmConnections)
      .set({ isDefault: false })
      .where(eq(llmConnections.isDefault, true));
    await tx.update(llmConnections).set({ isDefault: true }).where(eq(llmConnections.id, id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.default_changed',
      targetType: 'llm_connection',
      targetId: id,
    });
    return { ok: true } as const;
  });
}

export async function retestLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true; connection: LlmConnectionView } | LlmServiceFailure> {
  assertCanManage(actor);
  const config = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(llmConnections).where(eq(llmConnections.id, id));
    return row ? readConfig(tx, deps, actor.orgId, row) : null;
  });
  if (!config) return notFound;
  const result = await probe(deps, config);
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [updated] = await tx
      .update(llmConnections)
      .set({
        status: result.ok ? 'ok' : 'error',
        lastError: result.ok ? null : result.code,
        lastCheckedAt: new Date(),
      })
      .where(eq(llmConnections.id, id))
      .returning();
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.retested',
      targetType: 'llm_connection',
      targetId: id,
      metadata: { ok: result.ok, ...(result.ok ? {} : { code: result.code }) },
    });
    return updated;
  });
  return row ? { ok: true, connection: toView(row) } : notFound;
}

const MAX_MODEL_LENGTH = 200;

/** The models the connection's stored key can use, for its "Change model" picker. */
export async function listLlmModelsForConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true; models: string[] } | LlmServiceFailure> {
  assertCanManage(actor);
  const config = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(llmConnections).where(eq(llmConnections.id, id));
    return row ? readConfig(tx, deps, actor.orgId, row) : null;
  });
  if (!config) return notFound;
  return modelsFor(deps, config);
}

/**
 * Switches a connection to a different model from the same key, re-testing it exactly like
 * `retestLlmConnection`. The model is kept even when the new test fails, so the connection shows
 * why instead of silently reverting. Label, prices and the default/background flags are untouched.
 */
export async function changeLlmModel(
  deps: LlmDeps,
  actor: Actor,
  id: string,
  model: string,
): Promise<
  | { ok: true; connection: LlmConnectionView }
  | LlmServiceFailure
  | { ok: false; code: 'invalid_input' }
> {
  assertCanManage(actor);
  const trimmed = model.trim();
  if (!trimmed || trimmed.length > MAX_MODEL_LENGTH) {
    return { ok: false, code: 'invalid_input' };
  }
  const loaded = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(llmConnections).where(eq(llmConnections.id, id));
    return row
      ? { previousModel: row.model, config: await readConfig(tx, deps, actor.orgId, row) }
      : null;
  });
  if (!loaded) return notFound;
  const config: LlmConfig = { ...loaded.config, model: trimmed };
  const result = await probe(deps, config);
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    const dek = await getOrgDek(tx, deps.keyring, actor.orgId);
    const [updated] = await tx
      .update(llmConnections)
      .set({
        model: trimmed,
        secret: encryptSecret(dek, secretContext(id), JSON.stringify(config)),
        status: result.ok ? 'ok' : 'error',
        lastError: result.ok ? null : result.code,
        lastCheckedAt: new Date(),
      })
      .where(eq(llmConnections.id, id))
      .returning();
    if (updated) {
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'llm_connection.model_changed',
        targetType: 'llm_connection',
        targetId: id,
        metadata: { from: loaded.previousModel, to: trimmed },
      });
    }
    return updated;
  });
  return row ? { ok: true, connection: toView(row) } : notFound;
}

export async function deleteLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | LlmServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    await lockOrgDefaults(tx, actor.orgId);
    const [deleted] = await tx
      .delete(llmConnections)
      .where(eq(llmConnections.id, id))
      .returning({ id: llmConnections.id, isDefault: llmConnections.isDefault });
    if (!deleted) return notFound;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.deleted',
      targetType: 'llm_connection',
      targetId: id,
    });
    if (deleted.isDefault) {
      // Keep the workspace usable: the most recently added remaining connection becomes the default.
      const [next] = await tx
        .select({ id: llmConnections.id })
        .from(llmConnections)
        .orderBy(desc(llmConnections.createdAt), desc(llmConnections.id))
        .limit(1);
      if (next) {
        await tx
          .update(llmConnections)
          .set({ isDefault: true })
          .where(eq(llmConnections.id, next.id));
        await recordAudit(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          action: 'llm_connection.default_changed',
          targetType: 'llm_connection',
          targetId: next.id,
          metadata: { reason: 'previous_default_deleted' },
        });
      }
    }
    return { ok: true } as const;
  });
}

/** A model with what the agent needs around it: the row id (usage) and prices (cost). */
export interface LoadedLlm {
  id: string;
  config: LlmConfig;
  prices: { inputMicros: number | null; outputMicros: number | null };
  /** Output tokens per model call (null = the default). */
  maxOutputTokens: number | null;
}

async function loadLlmWhere(
  deps: LlmDeps,
  orgId: string,
  where: SQL | undefined,
): Promise<LoadedLlm | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx.select().from(llmConnections).where(where).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      config: await readConfig(tx, deps, orgId, row),
      prices: { inputMicros: row.inputPriceMicros, outputMicros: row.outputPriceMicros },
      maxOutputTokens: row.maxOutputTokens,
    };
  });
}

/** The default model (chat). */
export function loadDefaultLlm(deps: LlmDeps, orgId: string): Promise<LoadedLlm | null> {
  return loadLlmWhere(deps, orgId, eq(llmConnections.isDefault, true));
}

/**
 * One of the workspace's models, picked for a conversation: null when it is gone or failing its
 * check, so the caller falls back to the default.
 */
export function loadUsableLlm(deps: LlmDeps, orgId: string, id: string): Promise<LoadedLlm | null> {
  return loadLlmWhere(
    deps,
    orgId,
    and(eq(llmConnections.id, id), ne(llmConnections.status, 'error')),
  );
}

/** The model for background skill runs: the "cheap model" when one is set, else the default. */
export async function loadBackgroundLlm(deps: LlmDeps, orgId: string): Promise<LoadedLlm | null> {
  return (
    (await loadLlmWhere(deps, orgId, eq(llmConnections.isBackground, true))) ??
    loadDefaultLlm(deps, orgId)
  );
}

/**
 * Picks the model for background skill runs, or clears the choice (`id: null` -> the default
 * model). Workspace owners/admins only.
 */
export async function setBackgroundLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string | null,
): Promise<{ ok: true } | LlmServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    await lockOrgDefaults(tx, actor.orgId);
    if (id !== null) {
      const [target] = await tx
        .select({ id: llmConnections.id })
        .from(llmConnections)
        .where(eq(llmConnections.id, id));
      if (!target) return notFound;
    }
    await tx
      .update(llmConnections)
      .set({ isBackground: false })
      .where(eq(llmConnections.isBackground, true));
    if (id !== null) {
      await tx.update(llmConnections).set({ isBackground: true }).where(eq(llmConnections.id, id));
    }
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.background_changed',
      targetType: 'llm_connection',
      targetId: id ?? 'default',
    });
    return { ok: true } as const;
  });
}

export async function loadDefaultLlmConfig(
  deps: LlmDeps,
  orgId: string,
): Promise<LlmConfig | null> {
  return (await loadDefaultLlm(deps, orgId))?.config ?? null;
}

const MAX_PRICE_MICROS = 1_000_000_000; // 1,000 currency units per million tokens

/** Sets (or clears, with null) a connection's prices per million tokens. Owners/admins only. */
export async function setLlmConnectionPrices(
  deps: LlmDeps,
  actor: Actor,
  id: string,
  prices: { inputMicros: number | null; outputMicros: number | null },
): Promise<{ ok: true } | LlmServiceFailure | { ok: false; code: 'invalid_price' }> {
  assertCanManage(actor);
  const valid = (v: number | null) =>
    v === null || (Number.isInteger(v) && v >= 0 && v <= MAX_PRICE_MICROS);
  if (!valid(prices.inputMicros) || !valid(prices.outputMicros)) {
    return { ok: false, code: 'invalid_price' };
  }
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const updated = await tx
      .update(llmConnections)
      .set({ inputPriceMicros: prices.inputMicros, outputPriceMicros: prices.outputMicros })
      .where(eq(llmConnections.id, id))
      .returning({ id: llmConnections.id });
    if (updated.length === 0) return notFound;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.prices_changed',
      targetType: 'llm_connection',
      targetId: id,
      metadata: { inputMicros: prices.inputMicros, outputMicros: prices.outputMicros },
    });
    return { ok: true } as const;
  });
}

/**
 * Sets (or clears, with null: back to the default) how many tokens the model may write per call,
 * reasoning included. Owners/admins only.
 */
export async function setLlmMaxOutputTokens(
  deps: LlmDeps,
  actor: Actor,
  id: string,
  maxOutputTokens: number | null,
): Promise<{ ok: true } | LlmServiceFailure> {
  assertCanManage(actor);
  if (maxOutputTokens !== null && !isMaxOutputTokens(maxOutputTokens)) {
    return { ok: false, code: 'invalid_input', message: 'Invalid maximum answer length.' };
  }
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const updated = await tx
      .update(llmConnections)
      .set({ maxOutputTokens })
      .where(eq(llmConnections.id, id))
      .returning({ id: llmConnections.id });
    if (updated.length === 0) return notFound;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.max_output_tokens_changed',
      targetType: 'llm_connection',
      targetId: id,
      metadata: { maxOutputTokens },
    });
    return { ok: true } as const;
  });
}
