'use server';

import {
  assertCanManage,
  changeLlmModel,
  createLlmConnection,
  deleteLlmConnection,
  ForbiddenError,
  listLlmModelsForConnection,
  retestLlmConnection,
  setBackgroundLlmConnection,
  setDefaultLlmConnection,
  setLlmConnectionPrices,
} from '@agile/connections';
import { type LlmConfig, listModels } from '@agile/llm';
import { checkOutboundUrl, createOutboundFetch } from '@agile/net';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectionDeps, requireActor } from '@/server/context';
import { parsePrice } from './price';

export type FormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string; reason?: string; host?: string };

const common = {
  label: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
};
const key = z.string().trim().min(1).max(1000);
const schema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.enum(['anthropic', 'openai', 'google', 'mistral']),
    ...common,
    apiKey: key,
  }),
  z.object({
    provider: z.literal('azure'),
    ...common,
    apiKey: key,
    resourceName: z.string().trim().min(1).max(100),
  }),
  z.object({
    provider: z.literal('openai_compatible'),
    ...common,
    baseUrl: z.string().trim().min(1).max(500),
    apiKey: z.string().trim().max(1000).optional(),
  }),
]);

// Same shape as `schema`, minus label and model: the add form has neither yet when it loads models.
const modelsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.enum(['anthropic', 'openai', 'google', 'mistral']), apiKey: key }),
  z.object({
    provider: z.literal('azure'),
    apiKey: key,
    resourceName: z.string().trim().min(1).max(100),
  }),
  z.object({
    provider: z.literal('openai_compatible'),
    baseUrl: z.string().trim().min(1).max(500),
    apiKey: z.string().trim().max(1000).optional(),
  }),
]);

export type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; code: string; reason?: string; host?: string };

const PATH = '/settings/llm';

export async function createLlmConnectionAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await requireActor();
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  const { label, ...config } = parsed.data;
  try {
    const result = await createLlmConnection(connectionDeps(), actor, {
      label,
      config: config as LlmConfig,
    });
    if (!result.ok) {
      // blocked_url carries a reason code (and host) the form translates; result.message is English, for logs only.
      return { status: 'error', code: result.code, ...result.detail };
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}

const isId = (id: unknown) => z.uuid().safeParse(id).success;

/** "Load models" on the add form: the key never gets saved, so a parse failure costs no token. */
export async function listModelsForNewConnectionAction(form: FormData): Promise<ListModelsResult> {
  const actor = await requireActor();
  try {
    assertCanManage(actor);
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
  const parsed = modelsSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, code: 'invalid_input' };
  const config = parsed.data;
  if (config.provider === 'azure') return { ok: false, code: 'not_supported' };
  if (config.provider === 'openai_compatible') {
    const deps = connectionDeps();
    const check = await checkOutboundUrl(config.baseUrl, deps);
    if (!check.ok) return { ok: false, code: 'blocked_url', reason: check.code, host: check.host };
    const result = await listModels(config, {
      fetch: createOutboundFetch({
        allowedPrivateHosts: deps.allowedPrivateHosts,
        resolve: deps.resolve,
      }),
    });
    if (!result.ok) return { ok: false, code: result.code };
    return { ok: true, models: result.models };
  }
  const result = await listModels(config);
  if (!result.ok) return { ok: false, code: result.code };
  return { ok: true, models: result.models };
}

/** "Change model" on a saved connection: lists what its stored key can use. */
export async function listModelsForConnectionAction(id: string): Promise<ListModelsResult> {
  const actor = await requireActor();
  if (!isId(id)) return { ok: false, code: 'not_found' };
  try {
    const result = await listLlmModelsForConnection(connectionDeps(), actor, id);
    if (!result.ok) return { ok: false, code: result.code, ...result.detail };
    return { ok: true, models: result.models };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
}

export async function changeLlmModelAction(
  id: string,
  model: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const actor = await requireActor();
  if (!isId(id)) return { ok: false, code: 'not_found' };
  try {
    const result = await changeLlmModel(connectionDeps(), actor, id, model);
    if (!result.ok) return { ok: false, code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function retestLlmConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isId(id)) return;
  await retestLlmConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

export async function deleteLlmConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isId(id)) return;
  await deleteLlmConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

export async function setDefaultLlmConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isId(id)) return;
  await setDefaultLlmConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

/** The model for background skill runs (`null`: back to the default model). */
export async function setBackgroundLlmConnectionAction(
  id: string | null,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const actor = await requireActor();
  if (id !== null && !isId(id)) return { ok: false, code: 'not_found' };
  try {
    const result = await setBackgroundLlmConnection(connectionDeps(), actor, id);
    if (!result.ok) return { ok: false, code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function setLlmPricesAction(
  id: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await requireActor();
  const input = parsePrice(String(form.get('input') ?? ''));
  const output = parsePrice(String(form.get('output') ?? ''));
  if (!isId(id) || !input.ok || !output.ok) return { status: 'error', code: 'invalid_price' };
  try {
    const result = await setLlmConnectionPrices(connectionDeps(), actor, id, {
      inputMicros: input.micros,
      outputMicros: output.micros,
    });
    if (!result.ok) return { status: 'error', code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  revalidatePath('/settings/usage');
  return { status: 'ok' };
}
