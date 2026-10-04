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
  id: string,
  _prev: InvitationState,
): Promise<InvitationState> {
  const parsed = invitationId.safeParse(id);
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  await requireSignedIn(`/invitations/${parsed.data}`);
  const h = await headers();
  const { auth } = services();
  let orgId: string | undefined;
  try {
    const accepted = await auth.api.acceptInvitation({
      headers: h,
      body: { invitationId: parsed.data },
    });
    orgId = accepted?.member.organizationId;
  } catch (e) {
    return { status: 'error', code: codeOf(e) };
  }
  if (orgId) {
    // Accepting already made it the active workspace in the database; this also refreshes the
    // session cookie. The membership exists either way, so a failure here is not the user's error.
    await auth.api
      .setActiveOrganization({ headers: h, body: { organizationId: orgId } })
      .catch(() => undefined);
  }
  redirect('/');
}

export async function rejectInvitationAction(
  id: string,
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
