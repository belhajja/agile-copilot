import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route is a thin shell over @agile/billing (whose tests sign real Stripe payloads): these
// tests pin what it answers and that the exact raw body reaches the signature check.
const billing = { secretKey: 'sk_test_1', webhookSecret: 'whsec_1', priceTeam: 'price_1' };
const billingDeps = vi.fn(() => ({
  db: { stub: true },
  billing: billing as typeof billing | null,
}));
vi.mock('@/server/billing', () => ({ billingDeps: () => billingDeps() }));

const handleStripeWebhook = vi.fn(
  async (_deps: unknown, _raw: string, _signature: string | null): Promise<string> => 'processed',
);
vi.mock('@agile/billing', async (importActual) => {
  const actual = await importActual<typeof import('@agile/billing')>();
  return {
    WebhookSignatureError: actual.WebhookSignatureError,
    handleStripeWebhook: (deps: unknown, raw: string, signature: string | null) =>
      handleStripeWebhook(deps, raw, signature),
  };
});

const { WebhookSignatureError } = await import('@agile/billing');
const route = await import('./route');

const post = (body: BodyInit, headers: Record<string, string> = { 'stripe-signature': 't=1' }) =>
  route.POST(
    new Request('http://localhost:3200/api/billing/webhook', {
      method: 'POST',
      body,
      headers,
      duplex: 'half',
    } as RequestInit),
  );

/** A body streamed without Content-Length, `size` bytes in 64 KiB chunks. */
const streamed = (size: number) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const n = Math.min(65_536, size - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
};

describe('POST /api/billing/webhook', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    billingDeps.mockReturnValue({ db: { stub: true }, billing });
    handleStripeWebhook.mockReset().mockResolvedValue('processed');
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it('runs on the Node runtime, never cached', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('answers 404 when billing is off (self-host), without reading the body', async () => {
    billingDeps.mockReturnValue({ db: { stub: true }, billing: null });
    const res = await post('{}');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(handleStripeWebhook).not.toHaveBeenCalled();
  });

  it('verifies the exact raw body with the Stripe-Signature header', async () => {
    // Spacing, key order and non-ASCII text must reach the signature check byte for byte.
    const raw = '{ "id":"evt_1",  "type":"customer.subscription.updated","x":"é€"}\n';
    const res = await post(raw, { 'stripe-signature': 't=1,v1=abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: 'processed' });
    expect(handleStripeWebhook).toHaveBeenCalledWith(
      { db: { stub: true }, billing },
      raw,
      't=1,v1=abc',
    );
  });

  it('answers 400 with a fixed code for a missing or bad signature', async () => {
    handleStripeWebhook.mockRejectedValue(new WebhookSignatureError('invalid signature'));
    const res = await post('{}', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_signature' });
    expect(handleStripeWebhook).toHaveBeenCalledWith(expect.anything(), '{}', null);
  });

  it('answers 200 for duplicate and ignored events (Stripe must not retry them)', async () => {
    for (const outcome of ['duplicate', 'ignored']) {
      handleStripeWebhook.mockResolvedValueOnce(outcome);
      const res = await post('{}');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, outcome });
    }
  });

  it('refuses a body over 512 KiB while streaming, whatever Content-Length says', async () => {
    const res = await post(streamed(512 * 1024 + 1), { 'stripe-signature': 't=1' });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(handleStripeWebhook).not.toHaveBeenCalled();
    const declared = await post('{}', { 'stripe-signature': 't=1', 'content-length': '999999' });
    expect(declared.status).toBe(413);
  });

  it('answers 500 (Stripe retries) and logs the error name only', async () => {
    const leak = Object.assign(new Error('sk_live_secret customer cus_123 failed'), {
      name: 'StripeAPIError',
    });
    handleStripeWebhook.mockRejectedValue(leak);
    const res = await post('{}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toContain('StripeAPIError');
    expect(logged).not.toContain('sk_live_secret');
    expect(logged).not.toContain('cus_123');
  });
});
