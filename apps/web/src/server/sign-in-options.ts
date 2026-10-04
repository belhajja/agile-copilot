import 'server-only';
import { services } from './context';

/** What the sign-in pages offer: SSO (and whether it answers now) and the password policy. */
export interface SignInOptions {
  /** `ready: false` only when the identity provider is known to be unreachable right now. */
  sso: { providerId: string; name: string; ready: boolean } | null;
  passwordLogin: 'all' | 'admin_only';
}

/**
 * How long the login page waits for a discovery attempt already in flight (M1). Past that the
 * button is offered anyway: the click itself waits for the attempt (a few seconds, with a pending
 * state) and shows a translated error if the provider is still down.
 */
export const SSO_PAGE_WAIT_MS = 500;

async function readyWithin(ready: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return await Promise.race([ready, inFlight]);
  } finally {
    clearTimeout(timer);
  }
}

export async function signInOptions(): Promise<SignInOptions> {
  const { env, authHolder } = services();
  const sso = env.OIDC_ISSUER
    ? {
        providerId: env.OIDC_PROVIDER,
        name: env.OIDC_DISPLAY_NAME,
        ready: await readyWithin(authHolder.ssoReady(), SSO_PAGE_WAIT_MS),
      }
    : null;
  return { sso, passwordLogin: env.PASSWORD_LOGIN };
}
