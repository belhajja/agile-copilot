import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((_url: string): never => {
  throw new Error('NEXT_REDIRECT');
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
vi.mock('@/server/billing', () => ({ billingDeps: () => ({ db: {}, billing: {} }) }));
vi.mock('@/server/context', () => ({
  requireActor: async () => ({ orgId: 'org_1', userId: 'u_1', roles: ['owner'] }),
  services: () => ({ env: { BETTER_AUTH_URL: 'https://app.example.com' } }),
}));
const startCheckout = vi.fn(async (..._args: unknown[]) => 'https://checkout.stripe.com/c/1');
const openBillingPortal = vi.fn(async (..._args: unknown[]) => 'https://billing.stripe.com/p/1');
vi.mock('@agile/billing', async (importActual) => {
  const actual = await importActual<typeof import('@agile/billing')>();
  return {
    BillingError: actual.BillingError,
    startCheckout: (...args: unknown[]) => startCheckout(...args),
    openBillingPortal: (...args: unknown[]) => openBillingPortal(...args),
  };
});

const { checkoutAction, portalAction } = await import('./actions');
const idle = { status: 'idle' } as const;

describe('billing actions', () => {
  beforeEach(() => {
    redirect.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sends Stripe our configured origin, never request headers', async () => {
    await expect(checkoutAction(idle)).rejects.toThrow('NEXT_REDIRECT');
    expect(startCheckout).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      successUrl: 'https://app.example.com/settings/billing?checkout=done',
      cancelUrl: 'https://app.example.com/settings/billing',
    });
    expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.com/c/1');
  });

  it.each([
    'http://checkout.stripe.com/c/1',
    'javascript:alert(1)',
    '/settings/billing',
    'not a url',
  ])('refuses to redirect to %s', async (url) => {
    startCheckout.mockResolvedValueOnce(url);
    openBillingPortal.mockResolvedValueOnce(url);
    expect(await checkoutAction(idle)).toEqual({ status: 'error', code: 'stripe_error' });
    expect(await portalAction(idle)).toEqual({ status: 'error', code: 'stripe_error' });
    expect(redirect).not.toHaveBeenCalled();
  });
});
