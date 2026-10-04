'use server';

import { deleteAccount } from '@agile/privacy';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireSignedIn, services } from '@/server/context';

export type DeleteAccountState =
  | { status: 'idle' }
  | { status: 'error'; code: 'confirm_mismatch' | 'reauth' | 'sole_owner' | 'rate_limited'; workspaces?: string[] };

/** Account deletion needs a sign-in younger than this (L13): a left-open session cannot do it. */
const FRESH_SIGN_IN_MS = 10 * 60_000;

/**
 * Expires the auth cookies (the sessions are gone with the account). A `__Secure-`/`__Host-`
 * cookie is only replaced by a Secure Set-Cookie, so those are expired with `secure: true`.
 */
async function dropAuthCookies() {
  const jar = await cookies();
  for (const c of jar.getAll()) {
    if (!c.name.includes('better-auth')) continue;
    const secure = c.name.startsWith('__Secure-') || c.name.startsWith('__Host-');
    jar.set(c.name, '', { maxAge: 0, path: '/', secure });
  }
}

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
    // P5-R44: a few attempts an hour, checked before any costly work.
    if (result.code === 'rate_limited') return { status: 'error', code: 'rate_limited' };
    // not_found: the account is already gone (deleted elsewhere); so are its sessions.
    await dropAuthCookies();
    redirect('/login');
  }
  await dropAuthCookies();
  redirect('/login');
}
