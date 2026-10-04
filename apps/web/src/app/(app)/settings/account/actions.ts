'use server';

import { deleteAccount } from '@agile/privacy';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireSignedIn, services } from '@/server/context';

export type DeleteAccountState =
  | { status: 'idle' }
  | { status: 'error'; code: 'confirm_mismatch' | 'reauth' | 'sole_owner'; workspaces?: string[] };

/** Account deletion needs a sign-in younger than this (L13): a left-open session cannot do it. */
const FRESH_SIGN_IN_MS = 10 * 60_000;

/**
 * Deletes the signed-in person's account after they typed their e-mail address to confirm. Open
 * to anyone signed in, with or without a workspace (M3).
 */
export async function deleteAccountAction(
  _prev: DeleteAccountState,
  form: FormData,
): Promise<DeleteAccountState> {
  const { user, session } = await requireSignedIn();
  const typed = String(form.get('confirm') ?? '')
    .trim()
    .toLowerCase();
  if (typed !== user.email.toLowerCase()) {
    return { status: 'error', code: 'confirm_mismatch' };
  }
  if (Date.now() - new Date(session.createdAt).getTime() > FRESH_SIGN_IN_MS) {
    return { status: 'error', code: 'reauth' };
  }
  const result = await deleteAccount(services().db, user.id);
  if (!result.ok) {
    if (result.code === 'sole_owner') {
      return { status: 'error', code: 'sole_owner', workspaces: result.workspaces };
    }
    redirect('/login');
  }
  // The sessions are gone with the account; drop the stale cookies too.
  const jar = await cookies();
  for (const c of jar.getAll()) {
    if (c.name.includes('better-auth')) jar.delete(c.name);
  }
  redirect('/login');
}
