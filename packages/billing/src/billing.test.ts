import {
  auditLog,
  billingSubscriptions,
  createDb,
  deletedOrganizations,
  organization,
  stripeEvents,
} from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
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
  purgeStripeEvents,
  startCheckout,
  WebhookSignatureError,
} from './billing';
import { PLANS, SELFHOST } from './plans';
import { signedEvent, startStripeMock } from './testing';

const owner = { orgId: 'org_a', userId: 'user_owner', roles: ['owner'] };
const admin = { orgId: 'org_a', userId: 'user_admin', roles: ['admin'] };
const ownerB = { ...owner, orgId: 'org_b' };
const T0 = 1_790_000_000;
const urls = { successUrl: 'http://x/ok', cancelUrl: 'http://x/no' };
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;

describe('billing (stripe-mock + Postgres)', () => {
  let tdb: TestDatabase | undefined;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  let mock: Awaited<ReturnType<typeof startStripeMock>> | undefined;
  let config: BillingConfig;
  let deps: BillingDeps;
  let stripe: Stripe;
  /** Stripe customers our Checkout created (stripe-mock gives random ids). */
  let customerA = '';
  let customerB = '';

  beforeAll(async () => {
    // Whichever container started is kept for afterAll to stop, even if the other one failed.
    const [db, stripeMock] = await Promise.allSettled([startTestDatabase(), startStripeMock()]);
    if (db.status === 'fulfilled') tdb = db.value;
    if (stripeMock.status === 'fulfilled') mock = stripeMock.value;
    if (!tdb || !mock) {
      throw db.status === 'rejected' ? db.reason : (stripeMock as PromiseRejectedResult).reason;
    }
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    await raw.db.insert(organization).values(
      ['a', 'b', 'c'].map((s) => ({
        id: `org_${s}`,
        name: s.toUpperCase(),
        slug: s,
        createdAt: new Date(),
      })),
    );
    config = {
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_test_secret',
      priceTeam: 'price_team',
      apiUrl: mock.url,
    };
    stripe = createStripe(config);
    deps = { db: app.db, billing: config, stripe };
  });
  afterAll(async () => {
    await app?.close();
    await raw?.close();
    await tdb?.stop();
    await mock?.stop();
  });

  const rowOf = async (orgId: string) =>
    (
      await raw.db.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId))
    )[0];
  const actionsOf = async (orgId: string, action: string) =>
    raw.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    object: 'subscription',
    customer: customerA,
    status: 'active',
    cancel_at_period_end: false,
    metadata: { app: 'agile-copilot', agile_copilot_org_id: 'org_a' },
    items: {
      data: [{ price: { id: 'price_team' }, current_period_end: T0 + 30 * 86_400 }],
    },
    ...over,
  });
  const subscriptionEvent = (
    id: string,
    type: string,
    created: number,
    over: Record<string, unknown> = {},
  ) => signedEvent(config.webhookSecret, { id, type, created, object: subscription(over) });
  const checkoutCompleted = (id: string, created: number, over: Record<string, unknown> = {}) =>
    signedEvent(config.webhookSecret, {
      id,
      type: 'checkout.session.completed',
      created,
      object: {
        id: `cs_${id}`,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: 'org_a',
        customer: customerA,
        subscription: 'sub_x',
        ...over,
      },
    });
  const deliver = async (e: { payload: string; signature: string }) =>
    handleStripeWebhook(deps, e.payload, e.signature);
  /** Stripe's current state of these subscriptions, as `subscriptions.retrieve` returns it. */
  const stripeHolds = (subs: Record<string, Record<string, unknown>>) =>
    vi.spyOn(stripe.subscriptions, 'retrieve').mockImplementation((async (id: string) => {
      const sub = subs[id];
      if (!sub)
        throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      return subscription({ id, ...sub });
    }) as never);
  const silenceWarnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('is off in self-host builds: no limits, and no entry point touches Stripe', async () => {
    const client = createStripe(config);
    const spies = [
      vi.spyOn(client.customers, 'create'),
      vi.spyOn(client.checkout.sessions, 'create'),
      vi.spyOn(client.checkout.sessions, 'list'),
      vi.spyOn(client.billingPortal.sessions, 'create'),
      vi.spyOn(client.subscriptions, 'list'),
      vi.spyOn(client.subscriptions, 'cancel'),
      vi.spyOn(client.webhooks, 'constructEventAsync'),
    ];
    const off: BillingDeps = { db: app.db, billing: null, stripe: client };
    expect(await getEntitlements(off, 'org_a')).toEqual(SELFHOST);
    expect(await billingView(off, 'org_a')).toMatchObject({
      entitlements: SELFHOST,
      hasCustomer: false,
    });
    await expect(startCheckout(off, owner, urls)).rejects.toMatchObject({
      code: 'billing_disabled',
    });
    await expect(openBillingPortal(off, owner, 'http://x/billing')).rejects.toMatchObject({
      code: 'billing_disabled',
    });
    const e = await subscriptionEvent('evt_off', 'customer.subscription.created', T0);
    await expect(handleStripeWebhook(off, e.payload, e.signature)).rejects.toMatchObject({
      code: 'billing_disabled',
    });
    await expect(cancelSubscriptionForOrg(off, 'org_a')).resolves.toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await rowOf('org_a')).toBeUndefined();
  });

  it('starts at the free plan; only owners open Checkout, a 30-minute session for this workspace', async () => {
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.free);
    await expect(startCheckout(deps, admin, urls)).rejects.toMatchObject({
      code: 'forbidden_role',
    });
    const create = vi.spyOn(stripe.checkout.sessions, 'create');
    const createCustomer = vi.spyOn(stripe.customers, 'create');
    const now = Math.floor(Date.now() / 1000);
    expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);
    // Our marker and an app-specific workspace key (P5-R46), on the customer and the subscription.
    const ours = { app: 'agile-copilot', agile_copilot_org_id: 'org_a' };
    expect(createCustomer.mock.calls[0]?.[0]).toEqual({ metadata: ours });
    createCustomer.mockRestore();
    const [params] = create.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      mode: 'subscription',
      client_reference_id: 'org_a',
      metadata: ours,
      subscription_data: { metadata: ours },
    });
    expect(params?.expires_at).toBeGreaterThanOrEqual(now + 30 * 60);
    expect(params?.expires_at).toBeLessThanOrEqual(now + 30 * 60 + 5);
    create.mockRestore();
    const row = await rowOf('org_a');
    customerA = row?.stripeCustomerId ?? '';
    expect(customerA).toMatch(/^cus_/);
    expect(row?.pendingCheckoutSessionId).toMatch(/^cs_/);
    const view = await billingView(deps, 'org_a');
    expect(view).toMatchObject({ hasCustomer: true, status: null, entitlements: PLANS.free });
    const audit = await raw.db.select().from(auditLog).where(eq(auditLog.orgId, 'org_a'));
    expect(audit.map((a) => a.action)).toEqual(['billing.checkout_started']);
    expect(await openBillingPortal(deps, owner, 'http://x/billing')).toMatch(/^https:\/\//);
  });

  it('keeps one open Checkout session per workspace', async () => {
    const retrieve = vi.spyOn(stripe.checkout.sessions, 'retrieve');
    const create = vi.spyOn(stripe.checkout.sessions, 'create');
    const first = (await rowOf('org_a'))?.pendingCheckoutSessionId;
    try {
      // Still open: the same session again, nothing new is created.
      retrieve.mockResolvedValueOnce({
        id: first,
        status: 'open',
        url: 'https://checkout.stripe.com/c/pay/cs_open',
      } as never);
      expect(await startCheckout(deps, owner, urls)).toBe(
        'https://checkout.stripe.com/c/pay/cs_open',
      );
      expect(retrieve).toHaveBeenCalledWith(
        first,
        { expand: ['subscription'] },
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(create).not.toHaveBeenCalled();

      // Paid in another tab, webhook not here yet: refused.
      retrieve.mockResolvedValueOnce({
        id: first,
        status: 'complete',
        subscription: { id: 'sub_paid', status: 'active' },
      } as never);
      await expect(startCheckout(deps, owner, urls)).rejects.toMatchObject({
        code: 'subscription_exists',
      });
      expect(create).not.toHaveBeenCalled();

      // Expired, gone, or completed for a subscription that has ended since: a new session.
      retrieve.mockResolvedValueOnce({ id: first, status: 'expired', url: null } as never);
      expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);
      retrieve.mockRejectedValueOnce(
        Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' }),
      );
      expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);
      retrieve.mockResolvedValueOnce({
        id: first,
        status: 'complete',
        subscription: { id: 'sub_old', status: 'canceled' },
      } as never);
      expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);
      expect(create).toHaveBeenCalledTimes(3);
      const latest = (await rowOf('org_a'))?.pendingCheckoutSessionId;
      expect(latest).toMatch(/^cs_/);

      // A session without a URL is its own error, and stores nothing.
      retrieve.mockResolvedValueOnce({ id: latest, status: 'expired', url: null } as never);
      create.mockResolvedValueOnce({ id: 'cs_no_url', url: null } as never);
      await expect(startCheckout(deps, owner, urls)).rejects.toMatchObject({
        code: 'no_checkout_url',
      });
      expect((await rowOf('org_a'))?.pendingCheckoutSessionId).toBe(latest);
      expect(await actionsOf('org_a', 'billing.checkout_started')).toHaveLength(4);
    } finally {
      retrieve.mockRestore();
      create.mockRestore();
    }
  });

  it('refuses webhooks without a valid, fresh signature', async () => {
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
    // A genuine delivery replayed after Stripe's tolerance (5 minutes).
    const replayed = await signedEvent(config.webhookSecret, {
      id: 'evt_replayed',
      type: 'customer.subscription.created',
      created: T0,
      object: subscription(),
      signedAt: Math.floor(Date.now() / 1000) - 600,
    });
    await expect(deliver(replayed)).rejects.toBeInstanceOf(WebhookSignatureError);
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
      { cancel_at_period_end: true },
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

  it('applies a delivery once when Stripe sends it twice at the same time', async () => {
    const e = await subscriptionEvent('evt_dup', 'customer.subscription.deleted', T0 + 35);
    const outcomes = await Promise.all([deliver(e), deliver(e)]);
    expect(outcomes.sort()).toEqual(['duplicate', 'processed']);
    const recorded = await raw.db.select().from(stripeEvents).where(eq(stripeEvents.id, 'evt_dup'));
    expect(recorded).toHaveLength(1);
  });

  it('ignores other event types; cancels the live subscription of a deleted workspace', async () => {
    const other = await signedEvent(config.webhookSecret, {
      id: 'evt_inv',
      type: 'invoice.paid',
      created: T0,
      object: { id: 'in_1', object: 'invoice' },
    });
    expect(await deliver(other)).toBe('ignored');

    await raw.db.insert(deletedOrganizations).values({ deletedOrgId: 'org_deleted' });
    const holds = stripeHolds({
      sub_gone: { status: 'active' },
      sub_gone_old: { status: 'canceled' },
    });
    // The customer we created for the deleted workspace, with our marker.
    const customers = vi.spyOn(stripe.customers, 'retrieve').mockResolvedValue({
      id: 'cus_gone',
      object: 'customer',
      metadata: { app: 'agile-copilot', agile_copilot_org_id: 'org_deleted' },
    } as never);
    const cancel = vi.spyOn(stripe.subscriptions, 'cancel').mockResolvedValue({} as never);
    try {
      const gone = (id: string, type: string, sub: string) =>
        subscriptionEvent(id, type, T0, {
          id: sub,
          customer: 'cus_gone',
          metadata: { app: 'agile-copilot', agile_copilot_org_id: 'org_deleted' },
        });
      expect(await deliver(await gone('evt_g1', 'customer.subscription.created', 'sub_gone'))).toBe(
        'ignored',
      );
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]?.[0]).toBe('sub_gone');
      expect(customers.mock.calls[0]?.[0]).toBe('cus_gone');
      // Already ended at Stripe, or a deletion: nothing to cancel.
      expect(
        await deliver(await gone('evt_g2', 'customer.subscription.updated', 'sub_gone_old')),
      ).toBe('ignored');
      expect(await deliver(await gone('evt_g3', 'customer.subscription.deleted', 'sub_gone'))).toBe(
        'ignored',
      );
      expect(cancel).toHaveBeenCalledTimes(1);
      // The key subscriptions carried before P5-R46 is still read.
      expect(
        await deliver(
          await subscriptionEvent('evt_g4', 'customer.subscription.updated', T0, {
            id: 'sub_gone',
            customer: 'cus_gone',
            metadata: { orgId: 'org_deleted' },
          }),
        ),
      ).toBe('ignored');
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      holds.mockRestore();
      customers.mockRestore();
      cancel.mockRestore();
    }
  });

  it('never cancels a subscription that is not ours (P5-R46)', async () => {
    const warn = silenceWarnings();
    const holds = stripeHolds({ sub_foreign: { status: 'active' } });
    const customerMeta: Record<string, Record<string, string>> = {
      cus_ours_never: { app: 'agile-copilot', agile_copilot_org_id: 'org_never' },
      cus_other_app: { orgId: 'org_deleted' },
      cus_ours_other_ws: { app: 'agile-copilot', agile_copilot_org_id: 'org_other' },
    };
    const customers = vi.spyOn(stripe.customers, 'retrieve').mockImplementation((async (
      id: string,
    ) => ({
      id,
      object: 'customer',
      metadata: customerMeta[id] ?? {},
    })) as never);
    const cancel = vi.spyOn(stripe.subscriptions, 'cancel').mockResolvedValue({} as never);
    try {
      const event = (id: string, customer: string, metadata: Record<string, string>) =>
        subscriptionEvent(id, 'customer.subscription.updated', T0, {
          id: 'sub_foreign',
          customer,
          metadata,
        });
      // Another product on the same Stripe account: a common `orgId` key, a workspace id that
      // was never one of ours.
      expect(await deliver(await event('evt_f1', 'cus_ours_never', { orgId: 'org_never' }))).toBe(
        'ignored',
      );
      // A deleted workspace's id, but a customer we did not create.
      expect(await deliver(await event('evt_f2', 'cus_other_app', { orgId: 'org_deleted' }))).toBe(
        'ignored',
      );
      // Our customer, but for another workspace.
      expect(
        await deliver(
          await event('evt_f3', 'cus_ours_other_ws', { agile_copilot_org_id: 'org_deleted' }),
        ),
      ).toBe('ignored');
      expect(cancel).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[billing] webhook_unknown_workspace',
        '[billing] webhook_unknown_workspace',
        '[billing] webhook_unknown_workspace',
      ]);
    } finally {
      warn.mockRestore();
      holds.mockRestore();
      customers.mockRestore();
      cancel.mockRestore();
    }
  });

  it('binds Checkout events to the Checkout this workspace started, with its own customer', async () => {
    expect(await startCheckout(deps, ownerB, urls)).toMatch(CHECKOUT_URL);
    const started = await rowOf('org_b');
    customerB = started?.stripeCustomerId ?? '';
    expect(customerB).toMatch(/^cus_/);
    const warn = silenceWarnings();
    const holds = stripeHolds({ sub_b: { customer: customerB, metadata: { orgId: 'org_b' } } });
    try {
      // A completed Checkout naming org_b, for a customer that is not org_b's.
      const foreign = await checkoutCompleted('evt_b1', T0, {
        client_reference_id: 'org_b',
        customer: 'cus_foreign',
        subscription: 'sub_f',
      });
      expect(await deliver(foreign)).toBe('ignored');
      // A one-off payment session, even with the right customer.
      const payment = await checkoutCompleted('evt_b2', T0, {
        mode: 'payment',
        client_reference_id: 'org_b',
        customer: customerB,
        subscription: null,
      });
      expect(await deliver(payment)).toBe('ignored');
      // A workspace that never started a Checkout.
      const noRow = await checkoutCompleted('evt_c1', T0, {
        client_reference_id: 'org_c',
        customer: customerB,
      });
      expect(await deliver(noRow)).toBe('ignored');
      // A subscription event naming org_b with a foreign customer.
      const foreignSub = await subscriptionEvent('evt_b3', 'customer.subscription.created', T0, {
        id: 'sub_f',
        customer: 'cus_foreign',
        metadata: { orgId: 'org_b' },
      });
      expect(await deliver(foreignSub)).toBe('ignored');
      expect(await rowOf('org_b')).toEqual(started);
      expect(await rowOf('org_c')).toBeUndefined();
      expect(holds).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[billing] webhook_foreign_customer',
        '[billing] webhook_checkout_not_subscription',
        '[billing] webhook_foreign_customer',
        '[billing] webhook_foreign_customer',
      ]);

      // Its own completed Checkout: the subscription's real state is read from Stripe.
      const own = await checkoutCompleted('evt_b4', T0 + 5, {
        id: started?.pendingCheckoutSessionId,
        client_reference_id: 'org_b',
        customer: customerB,
        subscription: 'sub_b',
      });
      expect(await deliver(own)).toBe('processed');
      expect(await rowOf('org_b')).toMatchObject({
        stripeCustomerId: customerB,
        stripeSubscriptionId: 'sub_b',
        status: 'active',
        plan: 'team',
        pendingCheckoutSessionId: null,
        lastEventAt: new Date((T0 + 5) * 1000),
      });
      await expect(startCheckout(deps, ownerB, urls)).rejects.toMatchObject({
        code: 'subscription_exists',
      });
    } finally {
      warn.mockRestore();
      holds.mockRestore();
    }
  });

  it('refuses a second Checkout while the workspace has a subscription that is not canceled', async () => {
    // sub_1 was canceled: the workspace subscribes again with a new subscription.
    expect(
      await deliver(
        await subscriptionEvent('evt_10', 'customer.subscription.created', T0 + 100, {
          id: 'sub_2',
        }),
      ),
    ).toBe('processed');
    expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.team);
    await expect(startCheckout(deps, owner, urls)).rejects.toMatchObject({
      code: 'subscription_exists',
    });
    await deliver(
      await subscriptionEvent('evt_11', 'customer.subscription.deleted', T0 + 110, {
        id: 'sub_2',
      }),
    );
    expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);
  });

  it("applies only the events of the workspace's stored subscription, recording the others", async () => {
    const warn = silenceWarnings();
    const cancel = vi.spyOn(stripe.subscriptions, 'cancel');
    try {
      expect(
        await deliver(
          await subscriptionEvent('evt_20', 'customer.subscription.created', T0 + 200, {
            id: 'sub_3',
          }),
        ),
      ).toBe('processed');
      expect((await rowOf('org_a'))?.stripeSubscriptionId).toBe('sub_3');

      // A late event of the old subscription (newer timestamp) changes nothing.
      expect(
        await deliver(
          await subscriptionEvent('evt_21', 'customer.subscription.deleted', T0 + 210, {
            id: 'sub_2',
          }),
        ),
      ).toBe('ignored');
      // Nor does another live subscription of the same workspace (a double charge).
      expect(
        await deliver(
          await subscriptionEvent('evt_22', 'customer.subscription.updated', T0 + 220, {
            id: 'sub_4',
            status: 'canceled',
          }),
        ),
      ).toBe('ignored');
      expect(await rowOf('org_a')).toMatchObject({
        stripeSubscriptionId: 'sub_3',
        status: 'active',
      });
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[billing] webhook_foreign_subscription',
        '[billing] webhook_foreign_subscription',
      ]);
      // Made visible, never canceled automatically.
      const recorded = await actionsOf('org_a', 'billing.foreign_subscription');
      expect(recorded.map((r) => r.metadata)).toEqual([
        { subscription: 'sub_2', event: 'customer.subscription.deleted' },
        { subscription: 'sub_4', event: 'customer.subscription.updated' },
      ]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      cancel.mockRestore();
    }
  });

  it('never locks a workspace out of Checkout with a stale or dead completed Checkout', async () => {
    await deliver(
      await subscriptionEvent('evt_30', 'customer.subscription.deleted', T0 + 300, { id: 'sub_3' }),
    );
    const warn = silenceWarnings();
    const holds = stripeHolds({
      sub_stale: { status: 'active' },
      sub_dead: { status: 'canceled' },
      sub_5: { status: 'active' },
    });
    try {
      // Older than what was applied: ignored, the canceled state stays.
      expect(
        await deliver(await checkoutCompleted('evt_31', T0 + 250, { subscription: 'sub_stale' })),
      ).toBe('ignored');
      expect(warn.mock.calls.map(([line]) => line)).toEqual(['[billing] webhook_stale_checkout']);
      expect(await rowOf('org_a')).toMatchObject({
        stripeSubscriptionId: 'sub_3',
        status: 'canceled',
      });
      expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);

      // Newer, but its subscription has ended at Stripe: stored as it really is, not "pending".
      expect(
        await deliver(await checkoutCompleted('evt_32', T0 + 310, { subscription: 'sub_dead' })),
      ).toBe('processed');
      expect(await rowOf('org_a')).toMatchObject({
        stripeSubscriptionId: 'sub_dead',
        status: 'canceled',
        lastEventAt: new Date((T0 + 310) * 1000),
      });
      expect(await startCheckout(deps, owner, urls)).toMatch(CHECKOUT_URL);

      expect(
        await deliver(await checkoutCompleted('evt_33', T0 + 320, { subscription: 'sub_5' })),
      ).toBe('processed');
      expect(await getEntitlements(deps, 'org_a')).toEqual(PLANS.team);
    } finally {
      warn.mockRestore();
      holds.mockRestore();
    }
  });

  it('re-fetches the subscription from Stripe when two events share a timestamp', async () => {
    const retrieve = stripeHolds({
      sub_5: {
        cancel_at_period_end: true,
        items: { data: [{ price: { id: 'price_team' }, current_period_end: T0 + 60 * 86_400 }] },
      },
    });
    try {
      expect(
        await deliver(
          await subscriptionEvent('evt_40', 'customer.subscription.updated', T0 + 400, {
            id: 'sub_5',
          }),
        ),
      ).toBe('processed');
      expect(retrieve).not.toHaveBeenCalled();
      // Same second, arriving last: which one is newer is unknown, so Stripe's current state wins.
      expect(
        await deliver(
          await subscriptionEvent('evt_41', 'customer.subscription.updated', T0 + 400, {
            id: 'sub_5',
            status: 'past_due',
          }),
        ),
      ).toBe('processed');
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieve).toHaveBeenCalledWith(
        'sub_5',
        {},
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      const view = await billingView(deps, 'org_a');
      expect(view).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
      expect(view.currentPeriodEnd?.getTime()).toBe((T0 + 60 * 86_400) * 1000);
    } finally {
      retrieve.mockRestore();
    }
  });

  it('forgets processed event ids after 30 days', async () => {
    const day = 86_400_000;
    const now = new Date();
    await raw.db.insert(stripeEvents).values([
      { id: 'evt_old', type: 'invoice.paid', receivedAt: new Date(now.getTime() - 31 * day) },
      { id: 'evt_recent', type: 'invoice.paid', receivedAt: new Date(now.getTime() - 29 * day) },
    ]);
    expect(await purgeStripeEvents(app.db, now)).toBe(1);
    const left = await raw.db.select({ id: stripeEvents.id }).from(stripeEvents);
    expect(left.map((r) => r.id)).toContain('evt_recent');
    expect(left.map((r) => r.id)).not.toContain('evt_old');

    // Every webhook delivery does the same.
    await raw.db.insert(stripeEvents).values({
      id: 'evt_old2',
      type: 'invoice.paid',
      receivedAt: new Date(now.getTime() - 31 * day),
    });
    const delivery = await signedEvent(config.webhookSecret, {
      id: 'evt_inv2',
      type: 'invoice.paid',
      created: T0,
      object: { id: 'in_2', object: 'invoice' },
    });
    expect(await deliver(delivery)).toBe('ignored');
    const after = await raw.db.select({ id: stripeEvents.id }).from(stripeEvents);
    expect(after.map((r) => r.id)).not.toContain('evt_old2');
    expect(after.map((r) => r.id)).toContain('evt_inv2');
  });

  it('stops all billing of a workspace being deleted, and only when it has a customer', async () => {
    const client = createStripe(config);
    const cancel = vi.spyOn(client.subscriptions, 'cancel').mockResolvedValue({} as never);
    const expire = vi.spyOn(client.checkout.sessions, 'expire').mockResolvedValue({} as never);
    const iterate = (items: unknown[]) =>
      ({
        async *[Symbol.asyncIterator]() {
          yield* items;
        },
      }) as never;
    // What Stripe holds for the customer: the stored subscription, an old canceled one, a stray
    // live one (e.g. from a second Checkout), and a Checkout still open in another tab.
    const list = vi.spyOn(client.subscriptions, 'list').mockReturnValue(
      iterate([
        { id: 'sub_5', status: 'active' },
        { id: 'sub_1', status: 'canceled' },
        { id: 'sub_9', status: 'past_due' },
      ]),
    );
    const sessions = vi
      .spyOn(client.checkout.sessions, 'list')
      .mockReturnValue(iterate([{ id: 'cs_open_1', status: 'open' }]));
    const withSpy = { ...deps, stripe: client };
    await cancelSubscriptionForOrg(withSpy, 'org_c');
    for (const spy of [list, sessions, cancel, expire]) expect(spy).not.toHaveBeenCalled();
    await cancelSubscriptionForOrg(withSpy, 'org_a');
    expect(sessions).toHaveBeenCalledWith({ customer: customerA, status: 'open', limit: 100 });
    expect(expire.mock.calls.map(([id]) => id)).toEqual(['cs_open_1']);
    expect(list).toHaveBeenCalledWith({ customer: customerA, status: 'all', limit: 100 });
    expect(cancel.mock.calls.map(([id]) => id).sort()).toEqual(['sub_5', 'sub_9']);
  });
});
