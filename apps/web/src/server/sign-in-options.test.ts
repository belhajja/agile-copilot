import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const services = vi.fn();
vi.mock('./context', () => ({ services: () => services() }));

const { signInOptions, SSO_PAGE_WAIT_MS } = await import('./sign-in-options');

const env = (over: Record<string, unknown> = {}) => ({
  OIDC_ISSUER: 'https://id.example.com/realms/acme',
  OIDC_PROVIDER: 'keycloak',
  OIDC_DISPLAY_NAME: 'Acme SSO',
  PASSWORD_LOGIN: 'all',
  ...over,
});
const withHolder = (ssoReady: () => Promise<boolean>, over?: Record<string, unknown>) =>
  services.mockReturnValue({ env: env(over), authHolder: { ssoReady } });

describe('signInOptions', () => {
  afterEach(() => {
    vi.useRealTimers();
    services.mockReset();
  });

  it('offers no SSO without an identity provider', async () => {
    withHolder(async () => false, { OIDC_ISSUER: undefined, PASSWORD_LOGIN: 'all' });
    expect(await signInOptions()).toEqual({ sso: null, passwordLogin: 'all' });
  });

  it('offers SSO, ready or not, with the password policy', async () => {
    withHolder(async () => true, { PASSWORD_LOGIN: 'admin_only' });
    expect(await signInOptions()).toEqual({
      sso: { providerId: 'keycloak', name: 'Acme SSO', ready: true },
      passwordLogin: 'admin_only',
    });
    withHolder(async () => false);
    expect((await signInOptions()).sso?.ready).toBe(false);
  });

  it('never holds the page for a discovery attempt in flight: the click waits instead (M1)', async () => {
    vi.useFakeTimers();
    withHolder(() => new Promise<boolean>(() => {}));
    const options = signInOptions();
    await vi.advanceTimersByTimeAsync(SSO_PAGE_WAIT_MS);
    expect((await options).sso?.ready).toBe(true);
    expect(SSO_PAGE_WAIT_MS).toBeLessThanOrEqual(1_000);
  });
});
