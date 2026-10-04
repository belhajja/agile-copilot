import { type Auth, type AuthOptions, createAuth } from './server';
import { discoveryUrlOf, type SsoConfig, ssoProviderId } from './sso';

/** Retry window for rebuilding the auth instance when the IdP could not be discovered. */
export const SSO_RETRY_MS = 30_000;
/** How long one discovery attempt may take before SSO is left off until the next retry. */
export const SSO_DISCOVERY_TIMEOUT_MS = 4_000;

export interface AuthHolder {
  /** The current auth instance (use for every auth call). Never waits for the IdP. */
  get(): Auth;
  /**
   * Whether SSO sign-in works now. better-auth discovers the IdP once, when the instance is
   * built; if the IdP was down then, SSO stays off. This retries discovery (at most once per
   * `SSO_RETRY_MS`, each attempt bounded by `SSO_DISCOVERY_TIMEOUT_MS`) and swaps in an
   * SSO-enabled instance once it succeeds, so SSO comes back without a restart.
   */
  ssoReady(): Promise<boolean>;
}

/** Why discovery failed, as logged: a fixed code (never the issuer, document or response). */
type DiscoveryFailure =
  | 'sso_issuer_mismatch'
  | 'sso_discovery_http'
  | 'sso_discovery_incomplete'
  | 'sso_discovery_timeout'
  | 'sso_discovery_unreachable'
  | 'sso_provider_skipped';

class DiscoveryError extends Error {
  override name = 'DiscoveryError';
  constructor(readonly code: DiscoveryFailure) {
    super(code);
  }
}

class DiscoveryTimeout extends Error {
  override name = 'TimeoutError';
}

const failureOf = (error: unknown): DiscoveryFailure => {
  if (error instanceof DiscoveryError) return error.code;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'sso_discovery_timeout';
  }
  return 'sso_discovery_unreachable';
};

const withTimeout = <T>(p: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DiscoveryTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The issuer's discovery document answers in time and describes a usable OIDC provider whose
 * issuer is the configured one. Nothing from the document is kept: better-auth fetches it again.
 */
async function discoverable(sso: SsoConfig, timeoutMs: number): Promise<void> {
  const res = await fetch(discoveryUrlOf(sso), {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new DiscoveryError('sso_discovery_http');
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new DiscoveryError('sso_discovery_incomplete');
  const issuer = typeof doc.issuer === 'string' ? doc.issuer.replace(/\/$/, '') : '';
  if (issuer !== sso.issuer.replace(/\/$/, '')) throw new DiscoveryError('sso_issuer_mismatch');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof doc[key] !== 'string') throw new DiscoveryError('sso_discovery_incomplete');
  }
}

/**
 * Holds the auth instance. Without SSO it is a plain `createAuth`. With SSO it starts with an
 * instance that has every SSO policy but no provider (so password and session requests never
 * wait for the IdP), checks discovery in the background with a timeout, and swaps to the
 * SSO-enabled instance only once that succeeds.
 */
export function createAuthHolder(
  options: AuthOptions,
  clock: { now: () => number } = { now: Date.now },
  discoveryTimeoutMs = SSO_DISCOVERY_TIMEOUT_MS,
): AuthHolder {
  const sso = options.sso;
  let auth = createAuth(options, { ssoProvider: false });
  if (!sso) return { get: () => auth, ssoReady: async () => false };

  let ready = false;
  let attemptedAt = clock.now();
  let inFlight: Promise<boolean> | null = null;

  const attempt = async (): Promise<boolean> => {
    try {
      await discoverable(sso, discoveryTimeoutMs);
      const candidate = createAuth(options);
      const ctx = await withTimeout(candidate.$context, discoveryTimeoutMs);
      if (!ctx.socialProviders.some((p) => p.id === ssoProviderId(sso))) {
        throw new DiscoveryError('sso_provider_skipped');
      }
      auth = candidate;
      ready = true;
    } catch (error) {
      console.warn(
        `[auth] ${failureOf(error)} ${error instanceof Error ? error.name : 'UnknownError'}`,
      );
    }
    return ready;
  };
  const start = () => {
    attemptedAt = clock.now();
    inFlight = attempt().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  void start();

  return {
    get: () => auth,
    async ssoReady() {
      if (ready) return true;
      if (inFlight) return inFlight;
      if (clock.now() - attemptedAt < SSO_RETRY_MS) return false;
      return start();
    },
  };
}
