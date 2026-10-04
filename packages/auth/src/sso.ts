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
export const ID_TOKEN_SIGN_IN_DISABLED = 'ID_TOKEN_SIGN_IN_DISABLED';
export const SCOPES_NOT_ALLOWED = 'SCOPES_NOT_ALLOWED';
export const SIGN_UP_NOT_ALLOWED = 'SIGN_UP_NOT_ALLOWED';

/** Endpoints that start an SSO sign-in or link. */
const SSO_START_PATHS = new Set(['/sign-in/social', '/link-social']);

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
 * Before-hook: SSO starts only as the redirect flow (authorization code, PKCE, nonce) with the
 * scopes we configured. A browser may not hand us an ID token directly (no nonce bound to its
 * session, so a token leaked elsewhere would sign in) nor ask for extra scopes (offline_access…).
 */
export function guardSsoStart(ctx: { path?: string; body?: unknown }): void {
  if (!ctx.path || !SSO_START_PATHS.has(ctx.path)) return;
  const body = (ctx.body ?? {}) as { idToken?: unknown; scopes?: unknown };
  if (body.idToken !== undefined) {
    throw new APIError('BAD_REQUEST', {
      code: ID_TOKEN_SIGN_IN_DISABLED,
      message: 'Sign in through your organisation account page.',
    });
  }
  if (body.scopes !== undefined) {
    throw new APIError('BAD_REQUEST', {
      code: SCOPES_NOT_ALLOWED,
      message: 'Additional scopes cannot be requested.',
    });
  }
}

/**
 * Before-hook: break-glass accounts are created server-side only (the `break-glass:create` CLI,
 * which calls the API without an HTTP request). Over HTTP their sign-up is refused in every
 * mode, so nobody can claim a platform admin address first. The message names no reason.
 */
export function guardBreakGlassSignUp(
  ctx: { path?: string; body?: unknown; request?: Request },
  breakGlassEmails: readonly string[],
): void {
  if (ctx.path !== '/sign-up/email' || !ctx.request) return;
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== 'string' || !isBreakGlass(email, breakGlassEmails)) return;
  throw new APIError('FORBIDDEN', {
    code: SIGN_UP_NOT_ALLOWED,
    message: 'This address cannot sign up here.',
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
