import type { Auth } from './server';
import { breakGlassCreation, isBreakGlass, normalizeEmail } from './sso';

/** The address is not in BREAK_GLASS_EMAILS. */
export const NOT_BREAK_GLASS = 'NOT_BREAK_GLASS';

/**
 * Creates a break-glass account (a platform admin who signs in with a password when the IdP is
 * down). Server-side only: it calls the auth API without an HTTP request and inside the
 * `breakGlassCreation` marker, the one way such an account can be created (any other sign-up of
 * these addresses is refused, A-m2). The session sign-up
 * opens is closed again, so no usable token is left behind.
 */
export async function createBreakGlassAccount(
  auth: Auth,
  breakGlassEmails: readonly string[],
  account: { email: string; password: string; name: string },
): Promise<{ email: string }> {
  const email = normalizeEmail(account.email);
  if (!isBreakGlass(email, breakGlassEmails)) throw new Error(NOT_BREAK_GLASS);
  const { headers, response } = await breakGlassCreation.run(true, () =>
    auth.api.signUpEmail({
      body: { email, password: account.password, name: account.name },
      returnHeaders: true,
    }),
  );
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  if (cookie) await auth.api.signOut({ headers: new Headers({ cookie }) });
  return { email: response.user.email };
}
