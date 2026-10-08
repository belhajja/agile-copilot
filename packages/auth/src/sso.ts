import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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

/** No longer sent (P5-R39: a refused sign-in reads as a wrong password); kept for importers. */
export const PASSWORD_LOGIN_DISABLED = 'PASSWORD_LOGIN_DISABLED';
export const ID_TOKEN_SIGN_IN_DISABLED = 'ID_TOKEN_SIGN_IN_DISABLED';
export const SCOPES_NOT_ALLOWED = 'SCOPES_NOT_ALLOWED';
export const SIGN_UP_NOT_ALLOWED = 'SIGN_UP_NOT_ALLOWED';
const SSO_UNLINK_NOT_ALLOWED = 'SSO_UNLINK_NOT_ALLOWED';

/** Endpoints that start an SSO sign-in or link. */
const SSO_START_PATHS = new Set(['/sign-in/social', '/link-social']);

/** Emails are compared trimmed and lower-cased, as better-auth stores them. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function isBreakGlass(email: string, breakGlassEmails: readonly string[]): boolean {
  const e = normalizeEmail(email);
  return breakGlassEmails.some((b) => normalizeEmail(b) === e);
}

/**
 * Where a refused password sign-in is pointed: an address no account can have (random per
 * process, reserved `.invalid` domain). better-auth then answers exactly as for an unknown address:
 * one password hash, then 401 `INVALID_EMAIL_OR_PASSWORD` (same status, body and cost).
 */
const NO_PASSWORD_ACCOUNT = `no-password-login-${randomUUID()}@password-login.invalid`;

/** The answer to a sign-up refused by policy, the same for every address (P5-R39). */
export const signUpRefused = () =>
  new APIError('FORBIDDEN', { code: SIGN_UP_NOT_ALLOWED, message: 'Sign-up is not available.' });

/**
 * better-auth's own answer to a sign-up with an address that already has an account (our
 * configuration: no e-mail verification, auto sign-in), byte for byte.
 */
const addressTaken = () =>
  new APIError('UNPROCESSABLE_ENTITY', {
    code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    message: 'User already exists. Use another email.',
  });

/**
 * Set only while `createBreakGlassAccount` (the operator's CLI) signs a break-glass account up
 * (A-m2). An explicit, process-internal marker: neither a browser nor an in-process call that
 * merely lacks an HTTP request (a server action, say) can claim to be the operator.
 */
export const breakGlassCreation = new AsyncLocalStorage<true>();

/**
 * Before-hook for the password policy. It never tells who is a platform administrator (P5-R39):
 * - Sign-up: break-glass accounts are created server-side only (the `break-glass:create` CLI, which
 *   calls the API without an HTTP request inside `breakGlassCreation`). Anywhere else, with `PASSWORD_LOGIN=admin_only` every
 *   sign-up gets the same refusal; with `all`, a break-glass address reads like any taken address.
 * - Sign-in with `admin_only`: a non-break-glass address is answered like an unknown address
 *   (better-auth hashes, then 401 `INVALID_EMAIL_OR_PASSWORD`), even with the right password.
 * - Unlinking with `admin_only` is refused: SSO is the only sign-in left to everyone but the
 *   break-glass accounts, which have nothing to unlink (one password account, never SSO). The
 *   endpoint names an account id only, which a synchronous hook cannot resolve to a provider.
 */
export function guardPasswordLogin(
  ctx: { path?: string; body?: unknown; request?: Request },
  policy: { passwordLogin: PasswordLogin; breakGlassEmails: readonly string[] },
): void {
  const body = ctx.body as { email?: unknown } | undefined;
  const admin =
    typeof body?.email === 'string' && isBreakGlass(body.email, policy.breakGlassEmails);
  if (ctx.path === '/sign-up/email') {
    if (admin && !ctx.request && breakGlassCreation.getStore() === true) return; // the CLI
    if (policy.passwordLogin === 'admin_only') throw signUpRefused();
    if (admin) throw addressTaken();
    return;
  }
  if (policy.passwordLogin !== 'admin_only') return;
  if (ctx.path === '/sign-in/email' && !admin && body && typeof body.email === 'string') {
    body.email = NO_PASSWORD_ACCOUNT;
    return;
  }
  if (ctx.path === '/unlink-account') {
    throw new APIError('FORBIDDEN', {
      code: SSO_UNLINK_NOT_ALLOWED,
      message: 'Sign-in methods cannot be removed while password sign-in is off.',
    });
  }
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
