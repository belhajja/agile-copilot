'use server';

import {
  createJiraConnection,
  deleteJiraConnection,
  ForbiddenError,
  retestJiraConnection,
} from '@agile/connections';
import type { JiraCredentials } from '@agile/jira';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectionDeps, requireActor } from '@/server/context';

export type FormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string; message?: string };

const common = {
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(1).max(500),
};
const schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cloud_basic'),
    ...common,
    email: z.email(),
    apiToken: z.string().min(1).max(500),
  }),
  z.object({ kind: z.literal('datacenter_pat'), ...common, token: z.string().min(1).max(500) }),
]);

const PATH = '/settings/jira';

export async function createJiraConnectionAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await requireActor();
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  const { name, ...rest } = parsed.data;
  const credentials: JiraCredentials =
    rest.kind === 'cloud_basic'
      ? { kind: 'cloud_basic', baseUrl: rest.baseUrl, email: rest.email, apiToken: rest.apiToken }
      : { kind: 'datacenter_pat', baseUrl: rest.baseUrl, token: rest.token };
  try {
    const result = await createJiraConnection(connectionDeps(), actor, { name, credentials });
    if (!result.ok) {
      // blocked_url carries an operator-facing reason worth showing; other codes map to translated text.
      return {
        status: 'error',
        code: result.code,
        message: result.code === 'blocked_url' ? result.message : undefined,
      };
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}

export async function retestJiraConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  await retestJiraConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

export async function deleteJiraConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  await deleteJiraConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}
