import { can } from '@agile/auth';
import {
  type AuditAction,
  billingSubscriptions,
  type Db,
  organization,
  recordAudit,
  stripeEvents,
  type Tx,
  withOrg,
} from '@agile/db';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { type Entitlements, entitlementsOf, SELFHOST } from './plans';

/** SaaS billing settings. Absent (null) in self-host builds: billing is off. */
export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** Stripe price id of the Team plan. */
  priceTeam: string;
  /** Tests and local development only: a stripe-mock URL instead of api.stripe.com. */
  apiUrl?: string;
}

export interface BillingDeps {
  db: Db;
  billing: BillingConfig | null;
  /** Injected in tests; otherwise built from `billing`. */
  stripe?: Stripe;
}

export interface BillingActor {
  orgId: string;
  userId: string;
  roles: readonly string[];
}

export class BillingError extends Error {
  override name = 'BillingError';
  constructor(
    readonly code: 'billing_disabled' | 'forbidden_role' | 'no_customer' | 'subscription_exists',
  ) {
    super(code);
  }
}

export class WebhookSignatureError extends Error {
  override name = 'WebhookSignatureError';
}

/** A Stripe client (bounded time, two network retries); api.stripe.com unless `apiUrl` is set. */
export function createStripe(config: BillingConfig): Stripe {
  const url = config.apiUrl ? new URL(config.apiUrl) : null;
  return new Stripe(config.secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    ...(url
      ? {
          host: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          protocol: url.protocol === 'https:' ? 'https' : 'http',
        }
      : {}),
  });
}

const enabled = (deps: BillingDeps): BillingConfig => {
  if (!deps.billing) throw new BillingError('billing_disabled');
  return deps.billing;
};
const stripeOf = (deps: BillingDeps) => deps.stripe ?? createStripe(enabled(deps));

/** Stripe statuses after which a subscription never bills again. */
const ENDED_STATUSES: readonly string[] = ['canceled', 'incomplete_expired'];
const ended = (status: string | null) => status !== null && ENDED_STATUSES.includes(status);

/** The workspace's limits: unlimited in self-host builds, else from its subscription. */
export async function getEntitlements(deps: BillingDeps, orgId: string): Promise<Entitlements> {
  if (!deps.billing) return SELFHOST;
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({ plan: billingSubscriptions.plan, status: billingSubscriptions.status })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId)),
  );
  return entitlementsOf(row ?? null);
}

export interface BillingView {
  entitlements: Entitlements;
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  hasCustomer: boolean;
}

/** What the billing page shows. */
export async function billingView(deps: BillingDeps, orgId: string): Promise<BillingView> {
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId)),
  );
  return {
    entitlements: deps.billing ? entitlementsOf(row ?? null) : SELFHOST,
    status: row?.status ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    hasCustomer: Boolean(row),
  };
}

const assertOwner = (actor: BillingActor) => {
  if (!can(actor.roles, 'billing.manage')) throw new BillingError('forbidden_role');
};

/**
 * The workspace's Stripe customer, created on first use. The customer carries the workspace id
 * as metadata only: no names or addresses are sent (Checkout collects billing details itself).
 * Refuses when the workspace already has a subscription that has not ended (paid, pending after a
 * completed Checkout, or past due): a second Checkout would bill it twice. Owners use the portal.
 */
async function customerForCheckout(
  deps: BillingDeps,
  stripe: Stripe,
  orgId: string,
): Promise<string> {
  const [existing] = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({
        id: billingSubscriptions.stripeCustomerId,
        subscription: billingSubscriptions.stripeSubscriptionId,
        status: billingSubscriptions.status,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId)),
  );
  if (existing?.subscription && !ended(existing.status)) {
    throw new BillingError('subscription_exists');
  }
  if (existing) return existing.id;
  const customer = await stripe.customers.create({ metadata: { orgId } });
  // A concurrent checkout may have stored one first: keep that one.
  return withOrg(deps.db, orgId, async (tx) => {
    await tx
      .insert(billingSubscriptions)
      .values({ orgId, stripeCustomerId: customer.id })
      .onConflictDoNothing({ target: billingSubscriptions.orgId });
    const [row] = await tx
      .select({ id: billingSubscriptions.stripeCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId));
    return row?.id ?? customer.id;
  });
}

const audit = (
  tx: Tx,
  orgId: string,
  actorUserId: string | null,
  action: AuditAction,
  metadata: Record<string, unknown>,
) =>
  recordAudit(tx, { orgId, actorUserId, action, targetType: 'billing', targetId: orgId, metadata });

/** A Stripe Checkout page for the Team plan (owners only). Returns its URL. */
export async function startCheckout(
  deps: BillingDeps,
  actor: BillingActor,
  urls: { successUrl: string; cancelUrl: string },
): Promise<string> {
  const config = enabled(deps);
  assertOwner(actor);
  const stripe = stripeOf(deps);
  const customer = await customerForCheckout(deps, stripe, actor.orgId);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: config.priceTeam, quantity: 1 }],
    client_reference_id: actor.orgId,
    subscription_data: { metadata: { orgId: actor.orgId } },
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
  });
  if (!session.url) throw new BillingError('no_customer');
  await withOrg(deps.db, actor.orgId, (tx) =>
    audit(tx, actor.orgId, actor.userId, 'billing.checkout_started', { plan: 'team' }),
  );
  return session.url;
}

/** Stripe's customer portal (payment method, invoices, cancellation). Owners only. */
export async function openBillingPortal(
  deps: BillingDeps,
  actor: BillingActor,
  returnUrl: string,
): Promise<string> {
  enabled(deps);
  assertOwner(actor);
  const [row] = await withOrg(deps.db, actor.orgId, (tx) =>
    tx
      .select({ customer: billingSubscriptions.stripeCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, actor.orgId)),
  );
  if (!row) throw new BillingError('no_customer');
  const portal = await stripeOf(deps).billingPortal.sessions.create({
    customer: row.customer,
    return_url: returnUrl,
  });
  return portal.url;
}

const idOf = (v: string | { id: string } | null | undefined) =>
  typeof v === 'string' ? v : (v?.id ?? null);

const orgExists = async (tx: Tx, orgId: string) =>
  (await tx.$count(organization, eq(organization.id, orgId))) > 0;

/** Records the event id; false when it was already processed (Stripe delivers at least once). */
async function firstDelivery(tx: Tx, event: Stripe.Event): Promise<boolean> {
  const inserted = await tx
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  return inserted.length > 0;
}

/** The workspace's row, locked until the transaction ends (events of one workspace serialize). */
const lockedRow = async (tx: Tx, orgId: string) =>
  (
    await tx
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId))
      .for('update')
  )[0];

/**
 * Whether an event of `subscriptionId` may change the workspace: it must be the stored
 * subscription, unless none is stored or the stored one has ended (the workspace subscribed
 * again). Any other subscription (a second Checkout, a stale one) is logged and ignored.
 */
function belongsToWorkspace(
  row: { stripeSubscriptionId: string | null; status: string | null } | undefined,
  subscriptionId: string,
): boolean {
  if (!row?.stripeSubscriptionId || row.stripeSubscriptionId === subscriptionId) return true;
  if (ended(row.status)) return true;
  console.warn('[billing] webhook_foreign_subscription');
  return false;
}

/** A completed Checkout: stores the customer and the (pending) subscription it created. */
async function applyCheckout(
  tx: Tx,
  session: Stripe.Checkout.Session,
  orgId: string,
): Promise<WebhookOutcome> {
  const customer = idOf(session.customer);
  if (!customer) return 'ignored';
  const subscription = idOf(session.subscription);
  const row = await lockedRow(tx, orgId);
  if (!row) {
    await tx
      .insert(billingSubscriptions)
      .values({ orgId, stripeCustomerId: customer, stripeSubscriptionId: subscription });
    return 'processed';
  }
  if (!subscription || row.stripeSubscriptionId === subscription) {
    await tx
      .update(billingSubscriptions)
      .set({ stripeCustomerId: customer })
      .where(eq(billingSubscriptions.orgId, orgId));
    return 'processed';
  }
  if (!belongsToWorkspace(row, subscription)) return 'ignored';
  // A new subscription replaces an ended one: pending until its own events arrive.
  await tx
    .update(billingSubscriptions)
    .set({
      stripeCustomerId: customer,
      stripeSubscriptionId: subscription,
      plan: null,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })
    .where(eq(billingSubscriptions.orgId, orgId));
  return 'processed';
}

/**
 * Applies one subscription event of the workspace's subscription, unless a newer one was applied
 * already. Stripe's `created` has one-second resolution: on a tie the order is unknown, so the
 * subscription is re-read from Stripe and its current state applied.
 */
async function applySubscription(
  tx: Tx,
  config: BillingConfig,
  stripe: Stripe,
  event: Stripe.Event,
  sub: Stripe.Subscription,
  orgId: string,
): Promise<WebhookOutcome> {
  const row = await lockedRow(tx, orgId);
  if (!belongsToWorkspace(row, sub.id)) return 'ignored';
  const created = new Date(event.created * 1000);
  const last = row?.lastEventAt?.getTime();
  if (last !== undefined && last > created.getTime()) return 'processed';
  let state = sub;
  let status: string = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
  if (last === created.getTime()) {
    state = await stripe.subscriptions.retrieve(sub.id);
    status = state.status;
  }
  const item = state.items?.data?.[0];
  const values = {
    stripeCustomerId: idOf(state.customer) ?? row?.stripeCustomerId ?? '',
    stripeSubscriptionId: state.id,
    plan: item?.price?.id === config.priceTeam ? 'team' : null,
    status,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: state.cancel_at_period_end,
    lastEventAt: created,
  };
  await tx
    .insert(billingSubscriptions)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: billingSubscriptions.orgId, set: values });
  await audit(tx, orgId, null, 'billing.subscription_changed', {
    status: values.status,
    plan: values.plan,
  });
  return 'processed';
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

/**
 * A Stripe webhook: signature checked (raw body + `Stripe-Signature`, Stripe's default
 * tolerance), each event applied once, in a transaction with its dedup record so a failure
 * leaves it for Stripe's retry. The workspace comes from the ids we set at checkout
 * (`client_reference_id`, subscription metadata), never from anything a browser sends, and only
 * the workspace's stored subscription changes it.
 */
export async function handleStripeWebhook(
  deps: BillingDeps,
  payload: string,
  signature: string | null,
): Promise<WebhookOutcome> {
  const config = enabled(deps);
  if (!signature) throw new WebhookSignatureError('missing signature');
  const stripe = stripeOf(deps);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, config.webhookSecret);
  } catch {
    throw new WebhookSignatureError('invalid signature');
  }

  let orgId: string | null = null;
  if (event.type === 'checkout.session.completed') {
    orgId = event.data.object.client_reference_id ?? null;
  } else if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    orgId = event.data.object.metadata?.orgId ?? null;
  }

  if (!orgId) {
    await deps.db.transaction(async (tx) => {
      await firstDelivery(tx, event);
    });
    return 'ignored';
  }
  const target = orgId;
  return withOrg(deps.db, target, async (tx) => {
    if (!(await firstDelivery(tx, event))) return 'duplicate';
    // A deleted workspace's late events change nothing.
    if (!(await orgExists(tx, target))) return 'ignored';
    if (event.type === 'checkout.session.completed') {
      return applyCheckout(tx, event.data.object, target);
    }
    return applySubscription(
      tx,
      config,
      stripe,
      event,
      event.data.object as Stripe.Subscription,
      target,
    );
  });
}

/**
 * Stops billing a workspace that is being deleted (before its rows are purged): every
 * subscription of its customer that has not ended is canceled, not only the stored one (a second
 * Checkout or a webhook still in flight may have created another). A failure stops the deletion:
 * a workspace is never deleted while Stripe keeps charging for it.
 */
export async function cancelSubscriptionForOrg(deps: BillingDeps, orgId: string): Promise<void> {
  if (!deps.billing) return;
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({ customer: billingSubscriptions.stripeCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId)),
  );
  if (!row) return;
  const stripe = stripeOf(deps);
  const live: string[] = [];
  for await (const sub of stripe.subscriptions.list({
    customer: row.customer,
    status: 'all',
    limit: 100,
  })) {
    if (!ended(sub.status)) live.push(sub.id);
  }
  for (const id of live) await stripe.subscriptions.cancel(id);
}
