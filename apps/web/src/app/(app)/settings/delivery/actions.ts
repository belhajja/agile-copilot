'use server';

import { ForbiddenError } from '@agile/connections';
import { isUuid } from '@agile/db';
import { createDeliveryChannel, deleteDeliveryChannel, digestLabels } from '@agile/notify';
import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { notifyDeps } from '@/server/automation';
import { requireActor } from '@/server/context';

export type ChannelFormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string; reason?: string; host?: string };

/** The outcome of removing a channel: a code the UI translates (never silent). */
export type DeleteChannelResult = { ok: true } | { ok: false; code: string };

const PATH = '/settings/delivery';

/**
 * How a webhook answered its test message, reduced to "it failed": the HTTP status, or telling a
 * refused connection from a timeout, would let an admin probe internal services through it.
 */
const WEBHOOK_TEST_FAILURES = new Set(['rejected', 'unreachable', 'timeout']);

/** Only the fields of the chosen kind are sent on; the service validates them (zod, strict). */
function inputFrom(form: FormData): Record<string, unknown> {
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  };
  const kind = get('kind');
  if (kind === 'smtp') {
    return {
      kind,
      name: get('name'),
      host: get('host'),
      port: get('port'),
      security: get('security'),
      username: get('username'),
      password: get('password'),
      from: get('from'),
    };
  }
  return { kind, name: get('name'), url: get('url') };
}

export async function createChannelAction(
  _prev: ChannelFormState,
  form: FormData,
): Promise<ChannelFormState> {
  const actor = await requireActor();
  const labels = digestLabels(await getLocale());
  const input = inputFrom(form);
  try {
    const result = await createDeliveryChannel(notifyDeps(), actor, input, {
      testMessage: { title: labels.testTitle, text: labels.testText },
    });
    if (!result.ok) {
      if (input.kind !== 'smtp' && WEBHOOK_TEST_FAILURES.has(result.code)) {
        return { status: 'error', code: 'test_failed' };
      }
      return { status: 'error', code: result.code, reason: result.reason, host: result.host };
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}

export async function deleteChannelAction(id: string): Promise<DeleteChannelResult> {
  const actor = await requireActor();
  if (!isUuid(id)) return { ok: false, code: 'not_found' };
  try {
    const result = await deleteDeliveryChannel(notifyDeps(), actor, id);
    if (!result.ok) return { ok: false, code: result.code };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { ok: true };
}
