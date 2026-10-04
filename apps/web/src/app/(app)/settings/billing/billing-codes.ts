/**
 * Codes with a sentence under `billing.errors`: the closed `BillingError` codes of
 * `@agile/billing` and the action's own `stripe_error`. A test ties the list to the messages.
 */
export const BILLING_ERROR_CODES = [
  'billing_disabled',
  'forbidden_role',
  'no_customer',
  'subscription_exists',
  'no_checkout_url',
  'stripe_error',
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/** Stripe subscription statuses with a label under `billing.status` (a test ties them). */
export const BILLING_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
] as const;
