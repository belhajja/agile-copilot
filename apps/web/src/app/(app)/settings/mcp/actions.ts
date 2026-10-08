'use server';

import {
  createMcpToken,
  revokeMcpToken,
  TokenError,
  type TokenErrorCode,
} from '@agile/mcp-gateway';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { formData, uuid } from '@/server/action-input';
import { requireActor, services } from '@/server/context';
import { mcpDeps } from '@/server/mcp';

const PATH = '/settings/mcp';

export type CreateTokenState =
  | { status: 'idle' }
  | { status: 'created'; token: string }
  | { status: 'error'; code: TokenErrorCode };

export type RevokeTokenResult = { ok: true } | { ok: false; code: TokenErrorCode };

/** The form's raw fields; the gateway checks the name and the expiry bounds. */
const tokenFields = z.object({
  name: z.string().default(''),
  expiresInDays: z.coerce.number().default(90),
});

/** A new personal token, shown to its owner once (never stored in clear). */
export async function createTokenAction(
  _prev: CreateTokenState,
  form: unknown,
): Promise<CreateTokenState> {
  const actor = await requireActor();
  const data = formData.safeParse(form);
  const fields = tokenFields.safeParse(data.success ? Object.fromEntries(data.data) : null);
  if (!fields.success) return { status: 'error', code: 'invalid_input' };
  try {
    const { token } = await createMcpToken(mcpDeps(), actor, fields.data);
    revalidatePath(PATH);
    return { status: 'created', token };
  } catch (e) {
    if (e instanceof TokenError) return { status: 'error', code: e.code };
    throw e;
  }
}

/** Revokes one's own token, or anyone's for owners and admins (checked by the gateway). */
export async function revokeTokenAction(tokenId: unknown): Promise<RevokeTokenResult> {
  const actor = await requireActor();
  const parsed = uuid.safeParse(tokenId);
  if (!parsed.success) return { ok: false, code: 'not_found' };
  try {
    await revokeMcpToken(services().db, actor, parsed.data);
  } catch (e) {
    if (e instanceof TokenError) return { ok: false, code: e.code };
    throw e;
  }
  revalidatePath(PATH);
  return { ok: true };
}
