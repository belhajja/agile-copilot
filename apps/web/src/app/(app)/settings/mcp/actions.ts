'use server';

import {
  createMcpToken,
  revokeMcpToken,
  TokenError,
  type TokenErrorCode,
} from '@agile/mcp-gateway';
import { revalidatePath } from 'next/cache';
import { requireActor, services } from '@/server/context';
import { mcpDeps } from '@/server/mcp';

const PATH = '/settings/mcp';

export type CreateTokenState =
  | { status: 'idle' }
  | { status: 'created'; token: string }
  | { status: 'error'; code: TokenErrorCode };

export type RevokeTokenResult = { ok: true } | { ok: false; code: TokenErrorCode };

/** A new personal token, shown to its owner once (never stored in clear). */
export async function createTokenAction(
  _prev: CreateTokenState,
  form: FormData,
): Promise<CreateTokenState> {
  const actor = await requireActor();
  try {
    const { token } = await createMcpToken(mcpDeps(), actor, {
      name: String(form.get('name') ?? ''),
      expiresInDays: Number(form.get('expiresInDays') ?? 90),
    });
    revalidatePath(PATH);
    return { status: 'created', token };
  } catch (e) {
    if (e instanceof TokenError) return { status: 'error', code: e.code };
    throw e;
  }
}

/** Revokes one's own token, or anyone's for owners and admins (checked by the gateway). */
export async function revokeTokenAction(tokenId: string): Promise<RevokeTokenResult> {
  const actor = await requireActor();
  try {
    await revokeMcpToken(services().db, actor, tokenId);
  } catch (e) {
    if (e instanceof TokenError) return { ok: false, code: e.code };
    throw e;
  }
  revalidatePath(PATH);
  return { ok: true };
}
