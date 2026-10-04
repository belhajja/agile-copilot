'use server';

import { BillingError, openBillingPortal, startCheckout } from '@agile/billing';
import { redirect } from 'next/navigation';
import { allowedCode } from '@/lib/error-code';
import { billingDeps } from '@/server/billing';
import { requireActor, services } from '@/server/context';
import { BILLING_ERROR_CODES, type BillingErrorCode } from './billing-codes';

export type BillingState = { status: 'idle' } | { status: 'error'; code: BillingErrorCode };

/** Built from the configured origin, never from request headers (Host can be forged). */
const page = () => new URL('/settings/billing', services().env.BETTER_AUTH_URL).toString();

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

async function go(open: () => Promise<string>): Promise<BillingState> {
  let url: string;
  try {
    url = await open();
  } catch (e) {
    if (e instanceof BillingError) {
      return { status: 'error', code: allowedCode(e.code, BILLING_ERROR_CODES) ?? 'stripe_error' };
    }
    // Stripe's messages can echo request details: name only.
    console.error(
      JSON.stringify({ level: 'error', event: 'billing_failed', name: (e as Error)?.name }),
    );
    return { status: 'error', code: 'stripe_error' };
  }
  // Stripe's pages are https only: anything else (a misconfigured STRIPE_API_URL, a relative or
  // script URL) is never followed.
  if (!isHttps(url)) {
    console.error(JSON.stringify({ level: 'error', event: 'billing_redirect_refused' }));
    return { status: 'error', code: 'stripe_error' };
  }
  redirect(url);
}

/** Owner → Stripe Checkout for the Team plan (owner-only and one open session: @agile/billing). */
export async function checkoutAction(_prev: BillingState): Promise<BillingState> {
  const actor = await requireActor();
  return go(() =>
    startCheckout(billingDeps(), actor, {
      successUrl: `${page()}?checkout=done`,
      cancelUrl: page(),
    }),
  );
}

/** Owner → Stripe's customer portal (payment method, invoices, cancel). */
export async function portalAction(_prev: BillingState): Promise<BillingState> {
  const actor = await requireActor();
  return go(() => openBillingPortal(billingDeps(), actor, page()));
}
