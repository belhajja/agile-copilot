'use server';

import {
  createLlmConnection,
  deleteLlmConnection,
  ForbiddenError,
  retestLlmConnection,
  setDefaultLlmConnection,
} from '@agile/connections';
import type { LlmConfig } from '@agile/llm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectionDeps, requireActor } from '@/server/context';

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
