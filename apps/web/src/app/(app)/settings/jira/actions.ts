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
import { formData, uuid } from '@/server/action-input';
import { atlassianOAuth } from '@/server/atlassian';
import { connectionDeps, requireActor } from '@/server/context';

export type FormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string; reason?: string; host?: string };

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
  form: unknown,
): Promise<FormState> {
  const actor = await requireActor();
  const data = formData.safeParse(form);
  if (!data.success) return { status: 'error', code: 'invalid_input' };
  const parsed = schema.safeParse(Object.fromEntries(data.data));
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  const { name, ...rest } = parsed.data;
  const credentials: JiraCredentials =
    rest.kind === 'cloud_basic'
      ? { kind: 'cloud_basic', baseUrl: rest.baseUrl, email: rest.email, apiToken: rest.apiToken }
      : { kind: 'datacenter_pat', baseUrl: rest.baseUrl, token: rest.token };
  try {
    const result = await createJiraConnection(connectionDeps(), actor, { name, credentials });
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

export async function retestJiraConnectionAction(id: unknown): Promise<void> {
  const actor = await requireActor();
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return;
  await retestJiraConnection(
    { ...connectionDeps(), oauth: atlassianOAuth() ?? undefined },
    actor,
    parsed.data,
  );
  revalidatePath(PATH);
}

export async function deleteJiraConnectionAction(id: unknown): Promise<void> {
  const actor = await requireActor();
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return;
  await deleteJiraConnection(connectionDeps(), actor, parsed.data);
  revalidatePath(PATH);
}
