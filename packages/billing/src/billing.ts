import { can } from '@agile/auth';
import {
  type Actor,
  type AuditAction,
  billingSubscriptions,
  type Db,
  deletedOrganizations,
  organization,
  recordAudit,
  stripeEvents,
  type Tx,
  withOrg,
} from '@agile/db';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { type Entitlements, entitlementsOf, SELFHOST } from './plans';

/**
 * Metadata we put on every Stripe customer, Checkout session and subscription we create (P5-R46):
 * an app marker and the workspace id under an app-specific key. Other products on the same Stripe
 * account cannot be mistaken for ours by a common key such as `orgId`.
 */
const STRIPE_APP_MARKER = 'agile-copilot';
const STRIPE_ORG_KEY = 'agile_copilot_org_id';
/** The workspace key used before P5-R46; still read (never written). */
const LEGACY_ORG_KEY = 'orgId';

const ourMetadata = (orgId: string) => ({ app: STRIPE_APP_MARKER, [STRIPE_ORG_KEY]: orgId });

/** The workspace id in Stripe metadata: the app-specific key, else the legacy one. */
const orgIdOf = (metadata: Stripe.Metadata | null | undefined): string | null =>
  metadata?.[STRIPE_ORG_KEY] || metadata?.[LEGACY_ORG_KEY] || null;

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

export class BillingError extends Error {
  override name = 'BillingError';
  constructor(
    readonly code:
      | 'billing_disabled'
      | 'forbidden_role'
      | 'no_customer'
      | 'subscription_exists'
      | 'no_checkout_url',
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

/**
 * Stripe calls made while a database transaction holds the workspace's billing row: short, so a
 * slow Stripe never holds the lock for long. A failure rolls the transaction back (for a webhook,
 * its dedup record too, so Stripe retries the delivery).
 */
const UNDER_LOCK = { timeout: 5_000, maxNetworkRetries: 1 } satisfies Stripe.RequestOptions;

/** Checkout sessions expire after 30 minutes (Stripe's minimum), so a stale one never lingers. */
const CHECKOUT_TTL_SECONDS = 30 * 60;

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

const assertOwner = (actor: Actor) => {
  if (!can(actor.roles, 'billing.manage')) throw new BillingError('forbidden_role');
};

/** The workspace's row, locked until the transaction ends (billing changes serialize). */
const lockedRow = async (tx: Tx, orgId: string) =>
  (
    await tx
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId))
      .for('update')
  )[0];

/**
 * The workspace's Stripe customer row, created on first use. The customer carries our marker and
 * the workspace id as metadata only: no names or addresses are sent (Checkout collects billing
 * details itself).
 */
async function ensureCustomerRow(deps: BillingDeps, stripe: Stripe, orgId: string) {
  const [existing] = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({ id: billingSubscriptions.stripeCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.orgId, orgId)),
  );
  if (existing) return;
  const customer = await stripe.customers.create({ metadata: ourMetadata(orgId) });
  // A concurrent checkout may have stored one first: keep that one.
  await withOrg(deps.db, orgId, (tx) =>
    tx
      .insert(billingSubscriptions)
      .values({ orgId, stripeCustomerId: customer.id })
      .onConflictDoNothing({ target: billingSubscriptions.orgId }),
  );
}

/** The stored Checkout session as Stripe has it now; null when Stripe no longer knows it. */
async function pendingSession(stripe: Stripe, id: string) {
  try {
    return await stripe.checkout.sessions.retrieve(id, { expand: ['subscription'] }, UNDER_LOCK);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'resource_missing') return null;
    throw error;
  }
}

/** A completed session whose subscription may still bill (unknown counts as live). */
function completedLive(session: Stripe.Checkout.Session): boolean {
  const sub = session.subscription;
  if (!sub) return false;
  return typeof sub === 'string' ? true : !ended(sub.status);
}

const audit = (
  tx: Tx,
  orgId: string,
  actorUserId: string | null,
  action: AuditAction,
  metadata: Record<string, unknown>,
) =>
  recordAudit(tx, { orgId, actorUserId, action, targetType: 'billing', targetId: orgId, metadata });

/**
 * A Stripe Checkout page for the Team plan (owners only). Returns its URL. One Checkout per
 * workspace at a time: while the last session is open, its URL is returned again; a session paid
 * whose subscription has not ended, or a stored subscription that has not ended, refuses (a
 * second one would bill twice; owners manage it in the portal).
 */
export async function startCheckout(
  deps: BillingDeps,
  actor: Actor,
  urls: { successUrl: string; cancelUrl: string },
): Promise<string> {
  const config = enabled(deps);
  assertOwner(actor);
  const stripe = stripeOf(deps);
  await ensureCustomerRow(deps, stripe, actor.orgId);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const row = await lockedRow(tx, actor.orgId);
    if (!row) throw new BillingError('no_customer');
    if (row.stripeSubscriptionId && !ended(row.status)) {
      throw new BillingError('subscription_exists');
    }
    if (row.pendingCheckoutSessionId) {
      const pending = await pendingSession(stripe, row.pendingCheckoutSessionId);
      if (pending?.status === 'open' && pending.url) return pending.url;
      if (pending?.status === 'complete' && completedLive(pending)) {
        throw new BillingError('subscription_exists');
      }
    }
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: row.stripeCustomerId,
        line_items: [{ price: config.priceTeam, quantity: 1 }],
        client_reference_id: actor.orgId,
        metadata: ourMetadata(actor.orgId),
        subscription_data: { metadata: ourMetadata(actor.orgId) },
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS,
        success_url: urls.successUrl,
        cancel_url: urls.cancelUrl,
      },
      UNDER_LOCK,
    );
    if (!session.url) throw new BillingError('no_checkout_url');
    await tx
      .update(billingSubscriptions)
      .set({ pendingCheckoutSessionId: session.id })
      .where(eq(billingSubscriptions.orgId, actor.orgId));
    await audit(tx, actor.orgId, actor.userId, 'billing.checkout_started', { plan: 'team' });
    return session.url;
  });
}

/** Stripe's customer portal (payment method, invoices, cancellation). Owners only. */
export async function openBillingPortal(
  deps: BillingDeps,
  actor: Actor,
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

/** Logs a fixed code (no ids, no payload) and ignores the event. */
const ignore = (code: string): WebhookOutcome => {
  console.warn(`[billing] ${code}`);
  return 'ignored';
};

type BillingRow = typeof billingSubscriptions.$inferSelect;

/**
 * Whether an event of `subscriptionId` may change the workspace: it must be the stored
 * subscription, unless none is stored or the stored one has ended (the workspace subscribed
 * again). Any other subscription (a second Checkout, a stale one) is ignored, logged, and
 * recorded in the audit log so a double charge is visible; it is never canceled automatically.
 */
async function belongsToWorkspace(
  tx: Tx,
  row: BillingRow,
  subscriptionId: string,
  event: Stripe.Event,
): Promise<boolean> {
  if (!row.stripeSubscriptionId || row.stripeSubscriptionId === subscriptionId) return true;
  if (ended(row.status)) return true;
  ignore('webhook_foreign_subscription');
  await audit(tx, row.orgId, null, 'billing.foreign_subscription', {
    subscription: subscriptionId,
    event: event.type,
  });
  return false;
}

/** Writes a subscription's state (never its customer: that is ours, set at Checkout). */
async function writeSubscription(
  tx: Tx,
  config: BillingConfig,
  orgId: string,
  sub: Stripe.Subscription,
  status: string,
  eventAt: Date,
  extra: { pendingCheckoutSessionId?: null } = {},
): Promise<void> {
  const item = sub.items?.data?.[0];
  const values = {
    stripeSubscriptionId: sub.id,
    plan: item?.price?.id === config.priceTeam ? 'team' : null,
    status,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    lastEventAt: eventAt,
    ...extra,
  };
  await tx.update(billingSubscriptions).set(values).where(eq(billingSubscriptions.orgId, orgId));
  await audit(tx, orgId, null, 'billing.subscription_changed', {
    status: values.status,
    plan: values.plan,
  });
}

interface WebhookContext {
  config: BillingConfig;
  stripe: Stripe;
  event: Stripe.Event;
  orgId: string;
}

/**
 * A completed Checkout, accepted only from a subscription-mode session of the customer this
 * workspace's Checkout created. A new subscription replacing an ended one is read from Stripe and
 * stored as it really is (never left "pending"), unless the event is older than what was applied.
 */
async function applyCheckout(
  tx: Tx,
  { config, stripe, event, orgId }: WebhookContext,
  session: Stripe.Checkout.Session,
): Promise<WebhookOutcome> {
  if (session.mode !== 'subscription') return ignore('webhook_checkout_not_subscription');
  const row = await lockedRow(tx, orgId);
  if (!row || idOf(session.customer) !== row.stripeCustomerId) {
    return ignore('webhook_foreign_customer');
  }
  const subscription = idOf(session.subscription);
  const clearPending =
    row.pendingCheckoutSessionId === session.id ? { pendingCheckoutSessionId: null } : {};
  if (!subscription || row.stripeSubscriptionId === subscription) {
    await tx
      .update(billingSubscriptions)
      .set(clearPending)
      .where(eq(billingSubscriptions.orgId, orgId));
    return 'processed';
  }
  if (!(await belongsToWorkspace(tx, row, subscription, event))) return 'ignored';
  const created = new Date(event.created * 1000);
  if (row.lastEventAt && created.getTime() <= row.lastEventAt.getTime()) {
    return ignore('webhook_stale_checkout');
  }
  // Under the row lock (see UNDER_LOCK).
  const sub = await stripe.subscriptions.retrieve(subscription, {}, UNDER_LOCK);
  if (idOf(sub.customer) !== row.stripeCustomerId) return ignore('webhook_foreign_customer');
  await writeSubscription(tx, config, orgId, sub, sub.status, created, clearPending);
  return 'processed';
}

/**
 * Applies one event of the workspace's subscription (its own customer only), unless a newer one
 * was applied already. Stripe's `created` has one-second resolution: on a tie the order is
 * unknown, so the subscription is re-read from Stripe and its current state applied.
 */
async function applySubscription(
  tx: Tx,
  { config, stripe, event, orgId }: WebhookContext,
  sub: Stripe.Subscription,
): Promise<WebhookOutcome> {
  const row = await lockedRow(tx, orgId);
  if (!row || idOf(sub.customer) !== row.stripeCustomerId) {
    return ignore('webhook_foreign_customer');
  }
  if (!(await belongsToWorkspace(tx, row, sub.id, event))) return 'ignored';
  const created = new Date(event.created * 1000);
  const last = row.lastEventAt?.getTime();
  if (last !== undefined && last > created.getTime()) return 'processed';
  let state = sub;
  let status: string = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
  if (last === created.getTime()) {
    // Under the row lock, so a concurrent delivery waits for this one (see UNDER_LOCK).
    state = await stripe.subscriptions.retrieve(sub.id, {}, UNDER_LOCK);
    status = state.status;
  }
  await writeSubscription(tx, config, orgId, state, status, created);
  return 'processed';
}

/**
 * A subscription naming a workspace that no longer exists must not keep billing: unless Stripe
 * says it has ended (or this is its deletion), it is canceled. Only when it is provably ours
 * (P5-R46): the id was one of our workspaces (`deleted_organizations`, kept 90 days) and the
 * subscription's customer is one we created for that workspace (our marker and its id). Anything
 * else (another product on the same Stripe account, a subscription made by hand) is left alone.
 */
async function cancelOrphan(
  tx: Tx,
  stripe: Stripe,
  event: Stripe.Event,
  sub: Stripe.Subscription,
  orgId: string,
): Promise<WebhookOutcome> {
  if (event.type === 'customer.subscription.deleted' || ended(sub.status)) return 'ignored';
  const wasOurs =
    (await tx.$count(deletedOrganizations, eq(deletedOrganizations.deletedOrgId, orgId))) > 0;
  if (!wasOurs) return ignore('webhook_unknown_workspace');
  const customerId = idOf(sub.customer);
  if (!customerId) return ignore('webhook_unknown_workspace');
  const customer = await stripe.customers.retrieve(customerId, {}, UNDER_LOCK);
  const meta = customer.deleted ? null : customer.metadata;
  if (meta?.app !== STRIPE_APP_MARKER || orgIdOf(meta) !== orgId) {
    return ignore('webhook_unknown_workspace');
  }
  const current = await stripe.subscriptions.retrieve(sub.id, {}, UNDER_LOCK);
  if (!ended(current.status)) await stripe.subscriptions.cancel(sub.id, {}, UNDER_LOCK);
  return 'ignored';
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

const SUBSCRIPTION_EVENTS: readonly string[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

/**
 * A Stripe webhook: signature checked (raw body + `Stripe-Signature`, Stripe's default
 * tolerance), each event applied once, in a transaction with its dedup record so a failure
 * leaves it for Stripe's retry. The workspace comes from the ids we set at checkout
 * (`client_reference_id`, subscription metadata), never from anything a browser sends, and only
 * its own customer's events, for its stored subscription, change it.
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
  // Processed ids are forgotten after 30 days by the daily retention job (@agile/privacy).
  return applyEvent(deps.db, config, stripe, event);
}

async function applyEvent(
  db: Db,
  config: BillingConfig,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<WebhookOutcome> {
  let orgId: string | null = null;
  if (event.type === 'checkout.session.completed') {
    orgId = event.data.object.client_reference_id ?? null;
  } else if (SUBSCRIPTION_EVENTS.includes(event.type)) {
    orgId = orgIdOf((event.data.object as Stripe.Subscription).metadata);
  }

  if (!orgId) {
    await db.transaction(async (tx) => {
      await firstDelivery(tx, event);
    });
    return 'ignored';
  }
  const ctx: WebhookContext = { config, stripe, event, orgId };
  return withOrg(db, orgId, async (tx) => {
    if (!(await firstDelivery(tx, event))) return 'duplicate';
    if (event.type === 'checkout.session.completed') {
      // A deleted workspace's late Checkout changes nothing (its subscription's own events
      // cancel it below).
      if (!(await orgExists(tx, ctx.orgId))) return 'ignored';
      return applyCheckout(tx, ctx, event.data.object);
    }
    const sub = event.data.object as Stripe.Subscription;
    if (!(await orgExists(tx, ctx.orgId))) return cancelOrphan(tx, stripe, event, sub, ctx.orgId);
    return applySubscription(tx, ctx, sub);
  });
}

/**
 * Stops billing a workspace that is being deleted (before its rows are purged): its customer's
 * open Checkout sessions are expired, then every subscription that has not ended is canceled, not
 * only the stored one (a second Checkout or a webhook still in flight may have created another).
 * A failure stops the deletion: a workspace is never deleted while Stripe keeps charging for it.
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
  const open: string[] = [];
  for await (const session of stripe.checkout.sessions.list({
    customer: row.customer,
    status: 'open',
    limit: 100,
  })) {
    open.push(session.id);
  }
  for (const id of open) await stripe.checkout.sessions.expire(id);
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
