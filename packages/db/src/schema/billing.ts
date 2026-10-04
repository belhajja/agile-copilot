import { boolean, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

/**
 * A workspace's Stripe subscription (SaaS only; self-host builds never write it). Mirrors what
 * Stripe's webhooks said last; Stripe stays the source of truth for money.
 */
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    orgId: text('org_id').primaryKey(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** Our plan key (`team`), from the subscription's price; null until a subscription exists. */
    plan: text('plan'),
    /** Stripe's subscription status (active, trialing, past_due, canceled, …). */
    status: text('status'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** `created` of the last subscription event applied: older events arriving late are ignored. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('billing_subscriptions_customer_uq').on(t.stripeCustomerId),
    tenantPolicy('billing_subscriptions', t.orgId),
  ],
);

/**
 * Stripe event ids already processed (webhooks are delivered at least once). Not tenant data: an
 * id and a type, nothing else.
 */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: createdAt,
});
