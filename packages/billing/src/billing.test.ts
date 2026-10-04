import { auditLog, billingSubscriptions, createDb, organization } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type BillingConfig,
  type BillingDeps,
  billingView,
  cancelSubscriptionForOrg,
  createStripe,
  getEntitlements,
  handleStripeWebhook,
  openBillingPortal,
  startCheckout,
  WebhookSignatureError,
} from './billing';
import { PLANS, SELFHOST } from './plans';
import { signedEvent, startStripeMock } from './testing';

const owner = { orgId: 'org_a', userId: 'user_owner', roles: ['owner'] };
const admin = { orgId: 'org_a', userId: 'user_admin', roles: ['admin'] };
const T0 = 1_790_000_000;
const urls = { successUrl: 'http://x/ok', cancelUrl: 'http://x/no' };

describe('billing (stripe-mock + Postgres)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  let mock: Awaited<ReturnType<typeof startStripeMock>>;
  let config: BillingConfig;
  let deps: BillingDeps;

  beforeAll(async () => {
    [tdb, mock] = await Promise.all([startTestDatabase(), startStripeMock()]);
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    await raw.db.insert(organization).values([
      { id: 'org_a', name: 'A', slug: 'a', createdAt: new Date() },
      { id: 'org_b', name: 'B', slug: 'b', createdAt: new Date() },
    ]);
    config = {
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_test_secret',
      priceTeam: 'price_team',
      apiUrl: mock.url,
    };
    deps = { db: app.db, billing: config, stripe: createStripe(config) };
  });
  afterAll(async () => {
    await app?.close();
    await raw?.close();
    await tdb?.stop();
    await mock?.stop();
  });

  const subscriptionEvent = (
    id: string,
    type: string,
    created: number,
    over: Record<string, unknown> = {},
  ) =>
    signedEvent(config.webhookSecret, {
      id,
      type,
      created,
      object: {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_a',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { orgId: 'org_a' },
        items: {
          data: [{ price: { id: 'price_team' }, current_period_end: T0 + 30 * 86_400 }],
        },
        ...over,
      },
    });
  const deliver = async (e: { payload: string; signature: string }) =>
    handleStripeWebhook(deps, e.payload, e.signature);
  const storedSubscriptionId = async (orgId: string) =>
    (
      await raw.db
        .select({ id: billingSubscriptions.stripeSubscriptionId })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.orgId, orgId))
    )[0]?.id;

  it('is off in self-host builds: no limits, no Stripe', async () => {
    const off: BillingDeps = { db: app.db, billing: null };
    expect(await getEntitlements(off, 'org_a')).toEqual(SELFHOST);
    await expect(startCheckout(off, owner, urls)).rejects.toMatchObject({
      code: 'billing_disabled',
    });
  });

  it('starts at the free plan; only owners open Checkout', async () => {
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.free);
    await expect(startCheckout(deps, admin, urls)).rejects.toMatchObject({
      code: 'forbidden_role',
    });
    const url = await startCheckout(deps, owner, urls);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const view = await billingView(deps, 'org_a');
    expect(view).toMatchObject({ hasCustomer: true, status: null, entitlements: PLANS.free });
    const audit = await raw.db.select().from(auditLog).where(eq(auditLog.orgId, 'org_a'));
    expect(audit.map((a) => a.action)).toEqual(['billing.checkout_started']);
    expect(await openBillingPortal(deps, owner, 'http://x/billing')).toMatch(/^https:\/\//);
  });

  it('refuses webhooks without a valid signature', async () => {
    const e = await subscriptionEvent('evt_forged', 'customer.subscription.created', T0);
    await expect(handleStripeWebhook(deps, e.payload, 'v1=forged')).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
    await expect(handleStripeWebhook(deps, e.payload, null)).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
    // A body changed after signing.
    await expect(
      handleStripeWebhook(deps, e.payload.replace('active', 'trialing'), e.signature),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.free);
  });

  it('applies subscription events once, in order, whatever order they arrive in', async () => {
    const created = await subscriptionEvent('evt_1', 'customer.subscription.created', T0);
    expect(await deliver(created)).toBe('processed');
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.team);
    // Stripe delivers at least once.
    expect(await deliver(created)).toBe('duplicate');

    const canceledLater = await subscriptionEvent(
      'evt_3',
      'customer.subscription.updated',
      T0 + 20,
      {
        cancel_at_period_end: true,
      },
    );
    const olderUpdate = await subscriptionEvent('evt_2', 'customer.subscription.updated', T0 + 10, {
      status: 'past_due',
    });
    expect(await deliver(canceledLater)).toBe('processed');
    expect(await deliver(olderUpdate)).toBe('processed');
    const view = await billingView(deps, 'org_a');
    // The older event arrived last and changed nothing.
    expect(view).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(view.currentPeriodEnd?.getTime()).toBe((T0 + 30 * 86_400) * 1000);

    expect(
      await deliver(await subscriptionEvent('evt_4', 'customer.subscription.deleted', T0 + 30)),
    ).toBe('processed');
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.free);
    // org_b is untouched.
    expect(await getEntitlements(deps, 'org_b')).toEqual(PLANS.free);
  });

  it('ignores events of other types and of workspaces that no longer exist', async () => {
    const other = await signedEvent(config.webhookSecret, {
      id: 'evt_inv',
      type: 'invoice.paid',
      created: T0,
      object: { id: 'in_1', object: 'invoice' },
    });
    expect(await deliver(other)).toBe('ignored');
    const gone = await subscriptionEvent('evt_gone', 'customer.subscription.created', T0, {
      metadata: { orgId: 'org_deleted' },
    });
    expect(await deliver(gone)).toBe('ignored');
  });

  it('refuses a second Checkout while the workspace has a subscription that is not canceled', async () => {
    // sub_1 is canceled (evt_4): a new Checkout is allowed, and pending until Stripe confirms it.
    await deliver(
      await subscriptionEvent('evt_10', 'customer.subscription.updated', T0 + 100, {
        status: 'active',
      }),
    );
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.team);
    await expect(startCheckout(deps, owner, urls)).rejects.toMatchObject({
      code: 'subscription_exists',
    });
    await deliver(await subscriptionEvent('evt_11', 'customer.subscription.deleted', T0 + 110));
    expect(await startCheckout(deps, owner, urls)).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    // Checkout completed for org_b: a subscription is pending (no subscription event yet).
    const completed = (id: string, orgId: string, subscription: string, created: number) =>
      signedEvent(config.webhookSecret, {
        id,
        type: 'checkout.session.completed',
        created,
        object: {
          id: `cs_${id}`,
          object: 'checkout.session',
          client_reference_id: orgId,
          customer: `cus_${orgId}`,
          subscription,
        },
      });
    expect(await deliver(await completed('evt_12', 'org_b', 'sub_b', T0 + 120))).toBe('processed');
    expect(await storedSubscriptionId('org_b')).toBe('sub_b');
    await expect(startCheckout(deps, { ...owner, orgId: 'org_b' }, urls)).rejects.toMatchObject({
      code: 'subscription_exists',
    });
  });

  it("applies only the events of the workspace's stored subscription", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // sub_1 is canceled: the workspace subscribes again (sub_2), which becomes the stored one.
      expect(
        await deliver(
          await subscriptionEvent('evt_20', 'customer.subscription.created', T0 + 200, {
            id: 'sub_2',
          }),
        ),
      ).toBe('processed');
      expect(await storedSubscriptionId('org_a')).toBe('sub_2');
      expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.team);

      // A late event of the old subscription (newer timestamp) changes nothing.
      expect(
        await deliver(await subscriptionEvent('evt_21', 'customer.subscription.deleted', T0 + 210)),
      ).toBe('ignored');
      // Nor does another live subscription of the same workspace (a second Checkout elsewhere).
      expect(
        await deliver(
          await subscriptionEvent('evt_22', 'customer.subscription.updated', T0 + 220, {
            id: 'sub_3',
            status: 'canceled',
          }),
        ),
      ).toBe('ignored');
      expect(await storedSubscriptionId('org_a')).toBe('sub_2');
      expect(await billingView(deps, 'org_a')).toMatchObject({
        status: 'active',
        entitlements: PLANS.team,
      });
      expect(warn).toHaveBeenCalledTimes(2);
      for (const [line] of warn.mock.calls) {
        expect(line).toBe('[billing] webhook_foreign_subscription');
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('re-fetches the subscription from Stripe when two events share a timestamp', async () => {
    const stripe = deps.stripe;
    if (!stripe) throw new Error('stripe client missing');
    const retrieve = vi.spyOn(stripe.subscriptions, 'retrieve').mockResolvedValue({
      id: 'sub_2',
      object: 'subscription',
      customer: 'cus_a',
      status: 'active',
      cancel_at_period_end: true,
      metadata: { orgId: 'org_a' },
      items: { data: [{ price: { id: 'price_team' }, current_period_end: T0 + 60 * 86_400 }] },
    } as never);
    try {
      expect(
        await deliver(
          await subscriptionEvent('evt_30', 'customer.subscription.updated', T0 + 300, {
            id: 'sub_2',
          }),
        ),
      ).toBe('processed');
      expect(retrieve).not.toHaveBeenCalled();
      // Same second, arriving last: which one is newer is unknown, so Stripe's current state wins.
      expect(
        await deliver(
          await subscriptionEvent('evt_31', 'customer.subscription.updated', T0 + 300, {
            id: 'sub_2',
            status: 'past_due',
          }),
        ),
      ).toBe('processed');
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith('sub_2');
      const view = await billingView(deps, 'org_a');
      expect(view).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
      expect(view.currentPeriodEnd?.getTime()).toBe((T0 + 60 * 86_400) * 1000);
    } finally {
      retrieve.mockRestore();
    }
  });

  it('cancels every live subscription of a workspace being deleted, and only when it has one', async () => {
    const stripe = createStripe(config);
    const cancel = vi.spyOn(stripe.subscriptions, 'cancel');
    // What Stripe holds for the customer: the stored subscription, an old canceled one and a
    // stray live one (e.g. from a second Checkout).
    const listed = [
      { id: 'sub_2', status: 'active' },
      { id: 'sub_1', status: 'canceled' },
      { id: 'sub_3', status: 'past_due' },
    ];
    const list = vi.spyOn(stripe.subscriptions, 'list').mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield* listed;
      },
    } as never);
    const withSpy = { ...deps, stripe };
    await cancelSubscriptionForOrg(withSpy, 'org_none');
    expect(list).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await cancelSubscriptionForOrg(withSpy, 'org_a');
    expect(list).toHaveBeenCalledWith({ customer: 'cus_a', status: 'all', limit: 100 });
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual(['sub_2', 'sub_3']);
    // Billing off: nothing to cancel.
    await cancelSubscriptionForOrg({ db: app.db, billing: null, stripe }, 'org_a');
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
