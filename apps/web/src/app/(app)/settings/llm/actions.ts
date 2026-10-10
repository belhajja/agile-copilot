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
  setLlmAcceptsImages,
  setLlmConnectionPrices,
  setLlmMaxOutputTokens,
} from '@agile/connections';
import { type LlmConfig, listModels } from '@agile/llm';
import { checkOutboundUrl, createOutboundFetch } from '@agile/net';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { formData, uuid } from '@/server/action-input';
import { connectionDeps, requireActor } from '@/server/context';
import { parseAnswerBudget } from './answer-budget';
import { parsePrice } from './price';

export type FormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string; reason?: string; host?: string };

const common = {
  label: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200),
  maxOutputTokens: z.string().max(20).default(''),
  // A checked switch posts "on"; an unchecked one posts nothing.
  acceptsImages: z.literal('on').optional(),
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
  form: unknown,
): Promise<FormState> {
  const actor = await requireActor();
  const data = formData.safeParse(form);
  const parsed = schema.safeParse(data.success ? Object.fromEntries(data.data) : null);
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  const { label, maxOutputTokens, acceptsImages, ...config } = parsed.data;
  const budget = parseAnswerBudget(maxOutputTokens);
  if (!budget.ok) return { status: 'error', code: 'invalid_answer_budget' };
  try {
    const result = await createLlmConnection(connectionDeps(), actor, {
      label,
      config: config as LlmConfig,
      maxOutputTokens: budget.tokens,
      acceptsImages: acceptsImages === 'on',
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

const isId = (id: unknown): id is string => uuid.safeParse(id).success;

/** "Load models" on the add form: the key never gets saved, so a parse failure costs no token. */
export async function listModelsForNewConnectionAction(form: unknown): Promise<ListModelsResult> {
  const actor = await requireActor();
  try {
    assertCanManage(actor);
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
  const data = formData.safeParse(form);
  const parsed = modelsSchema.safeParse(data.success ? Object.fromEntries(data.data) : null);
  if (!parsed.success) return { ok: false, code: 'invalid_input' };
  const config = parsed.data;
  if (config.provider === 'azure') return { ok: false, code: 'not_supported' };
  if (config.provider === 'openai_compatible') {
    const deps = connectionDeps();
    const check = await checkOutboundUrl(config.baseUrl, deps);
    if (!check.ok && check.code === 'insecure_transport') {
      return { ok: false, code: 'insecure_transport' };
    }
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
export async function listModelsForConnectionAction(id: unknown): Promise<ListModelsResult> {
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
  id: unknown,
  model: unknown,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const actor = await requireActor();
  if (!isId(id)) return { ok: false, code: 'not_found' };
  // `model` crosses the server-action wire as arbitrary JSON; a crafted call could send anything.
  const parsedModel = z.string().safeParse(model);
  if (!parsedModel.success) return { ok: false, code: 'invalid_input' };
  try {
    const result = await changeLlmModel(connectionDeps(), actor, id, parsedModel.data);
    if (!result.ok) return { ok: false, code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function retestLlmConnectionAction(id: unknown): Promise<void> {
  const actor = await requireActor();
  if (!isId(id)) return;
  await retestLlmConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

export async function deleteLlmConnectionAction(id: unknown): Promise<void> {
  const actor = await requireActor();
  if (!isId(id)) return;
  await deleteLlmConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

export async function setDefaultLlmConnectionAction(id: unknown): Promise<void> {
  const actor = await requireActor();
  if (!isId(id)) return;
  await setDefaultLlmConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

/** The model for background skill runs (`null`: back to the default model). */
export async function setBackgroundLlmConnectionAction(
  id: unknown,
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

const priceFields = z.object({
  input: z.string().default(''),
  output: z.string().default(''),
});

export async function setLlmPricesAction(
  id: unknown,
  _prev: FormState,
  form: unknown,
): Promise<FormState> {
  const actor = await requireActor();
  const data = formData.safeParse(form);
  const fields = priceFields.safeParse(data.success ? Object.fromEntries(data.data) : null);
  if (!isId(id) || !fields.success) return { status: 'error', code: 'invalid_price' };
  const input = parsePrice(fields.data.input);
  const output = parsePrice(fields.data.output);
  if (!input.ok || !output.ok) return { status: 'error', code: 'invalid_price' };
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

const answerBudgetFields = z.object({ maxOutputTokens: z.string().max(20).default('') });

/** The connection's answer budget (an empty field: back to the default). */
export async function setLlmAnswerBudgetAction(
  id: unknown,
  _prev: FormState,
  form: unknown,
): Promise<FormState> {
  const actor = await requireActor();
  const data = formData.safeParse(form);
  const fields = answerBudgetFields.safeParse(data.success ? Object.fromEntries(data.data) : null);
  if (!isId(id) || !fields.success) return { status: 'error', code: 'invalid_answer_budget' };
  const budget = parseAnswerBudget(fields.data.maxOutputTokens);
  if (!budget.ok) return { status: 'error', code: 'invalid_answer_budget' };
  try {
    const result = await setLlmMaxOutputTokens(connectionDeps(), actor, id, budget.tokens);
    if (!result.ok) return { status: 'error', code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}

const acceptsImagesFields = z.object({ acceptsImages: z.enum(['true', 'false']) });

/** Whether the connection's model reads images (the chat offers attachments only then). */
export async function setLlmAcceptsImagesAction(
  id: unknown,
  _prev: FormState,
  form: unknown,
): Promise<FormState> {
  const actor = await requireActor();
  const data = formData.safeParse(form);
  const fields = acceptsImagesFields.safeParse(data.success ? Object.fromEntries(data.data) : null);
  if (!isId(id) || !fields.success) return { status: 'error', code: 'invalid_input' };
  try {
    const result = await setLlmAcceptsImages(
      connectionDeps(),
      actor,
      id,
      fields.data.acceptsImages === 'true',
    );
    if (!result.ok) return { status: 'error', code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}
