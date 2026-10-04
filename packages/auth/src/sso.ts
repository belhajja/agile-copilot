import { APIError } from 'better-auth/api';
import { type GenericOAuthConfig, keycloak } from 'better-auth/plugins/generic-oauth';

/**
 * The deployment's identity provider (one per deployment: Keycloak first, any OIDC IdP through
 * discovery). Trusted configuration, like MCP_ATLASSIAN_URL: it is never a tenant value. The
 * issuer is checked by `@agile/config` (https, except loopback or allowlisted hosts).
 */
export interface SsoConfig {
  /** `keycloak` uses better-auth's Keycloak helper; `oidc` any provider with discovery. */
  provider: 'keycloak' | 'oidc';
  /** Issuer URL, e.g. https://id.example.com/realms/acme (discovery at /.well-known/…). */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** `all`: everyone may use a password. `admin_only`: only the break-glass accounts may. */
export type PasswordLogin = 'all' | 'admin_only';

/** The provider id in URLs (/api/auth/callback/<id>) and in the `account` table. */
export const ssoProviderId = (sso: SsoConfig) => sso.provider;

/** The issuer's OIDC discovery document URL. */
export const discoveryUrlOf = (sso: SsoConfig) =>
  `${sso.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

export function ssoProviderConfig(sso: SsoConfig): GenericOAuthConfig {
  const common = { clientId: sso.clientId, clientSecret: sso.clientSecret };
  const base: GenericOAuthConfig =
    sso.provider === 'keycloak'
      ? keycloak({ ...common, issuer: sso.issuer })
      : {
          ...common,
          providerId: 'oidc',
          discoveryUrl: discoveryUrlOf(sso),
          scopes: ['openid', 'profile', 'email'],
          pkce: true,
        };
  // Never trust an ID token that was not verified against the discovered JWKS (L23): without
  // a usable issuer and jwks_uri the provider is left out instead.
  return { ...base, requireIdTokenVerification: true };
}

export const PASSWORD_LOGIN_DISABLED = 'PASSWORD_LOGIN_DISABLED';

/** Emails are compared trimmed and lower-cased, as better-auth stores them. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function isBreakGlass(email: string, breakGlassEmails: readonly string[]): boolean {
  const e = normalizeEmail(email);
  return breakGlassEmails.some((b) => normalizeEmail(b) === e);
}

/**
 * Before-hook: with `PASSWORD_LOGIN=admin_only`, the password endpoints serve the break-glass
 * accounts only (sign-in, and sign-up so an operator can create them). Everyone else signs in
 * through the identity provider.
 */
export function guardPasswordLogin(
  ctx: { path?: string; body?: unknown },
  policy: { passwordLogin: PasswordLogin; breakGlassEmails: readonly string[] },
): void {
  if (policy.passwordLogin !== 'admin_only') return;
  if (ctx.path !== '/sign-in/email' && ctx.path !== '/sign-up/email') return;
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof email === 'string' && isBreakGlass(email, policy.breakGlassEmails)) return;
  throw new APIError('FORBIDDEN', {
    code: PASSWORD_LOGIN_DISABLED,
    message: 'Sign in with your organisation account.',
  });
}

/**
 * The address an ID token vouches for, when its `email_verified` claim is true. Only called on
 * tokens better-auth already verified (signature, issuer, audience, nonce) before it stored the
 * account, so this only reads the claims.
 */
export function verifiedEmailOfIdToken(idToken: string | null | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
      email_verified?: unknown;
    };
    return claims.email_verified === true && typeof claims.email === 'string'
      ? normalizeEmail(claims.email)
      : null;
  } catch {
    return null;
  }
}
