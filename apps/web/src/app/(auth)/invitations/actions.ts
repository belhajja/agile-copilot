'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireSignedIn, services } from '@/server/context';

export type InvitationState = { status: 'idle' } | { status: 'error'; code: string };

const invitationId = z.string().min(1).max(100);

/** better-auth's error code (shown through the client allowlist; anything else is generic). */
const codeOf = (e: unknown) => {
  const code = (e as { body?: { code?: unknown } } | null)?.body?.code;
  return typeof code === 'string' ? code : 'unknown';
};

/**
 * Accepts an invitation as the signed-in user (better-auth checks that it is addressed to them,
 * and, with SSO, that the identity provider verified the address), then opens that workspace.
 */
export async function acceptInvitationAction(
  id: unknown,
  _prev: InvitationState,
): Promise<InvitationState> {
  const parsed = invitationId.safeParse(id);
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  await requireSignedIn(`/invitations/${parsed.data}`);
  try {
    // Accepting also makes it the session's active workspace (better-auth updates the session
    // row, and sessions are read from the database: no cookie cache to refresh).
    await services().auth.api.acceptInvitation({
      headers: await headers(),
      body: { invitationId: parsed.data },
    });
  } catch (e) {
    return { status: 'error', code: codeOf(e) };
  }
  redirect('/');
}

export async function rejectInvitationAction(
  id: unknown,
  _prev: InvitationState,
): Promise<InvitationState> {
  const parsed = invitationId.safeParse(id);
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  await requireSignedIn(`/invitations/${parsed.data}`);
  try {
    await services().auth.api.rejectInvitation({
      headers: await headers(),
      body: { invitationId: parsed.data },
    });
  } catch (e) {
    return { status: 'error', code: codeOf(e) };
  }
  redirect('/onboarding');
}
