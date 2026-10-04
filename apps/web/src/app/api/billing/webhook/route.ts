import { handleStripeWebhook, WebhookSignatureError } from '@agile/billing';
import { BodyTooLargeError, readBodyCapped } from '@agile/net';
import { billingDeps } from '@/server/billing';

// Stripe's SDK verifies the signature with Node's crypto.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stripe events are a few kilobytes; 512 KiB leaves room without letting anyone fill memory. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Stripe → us. No session (public in proxy.ts): the Stripe signature over the exact raw body is
 * the authentication, checked before anything parses it. 404 when billing is off (self-host), 400
 * for a missing (before the body is read) or bad signature, 200 for applied, duplicate and ignored events, 500 lets Stripe
 * retry. Bodies are fixed codes; errors are logged by name only (Stripe's messages can carry ids).
 */
export async function POST(request: Request) {
  const deps = billingDeps();
  if (!deps.billing) return Response.json({ error: 'not_found' }, { status: 404 });
  // No signature, nothing to verify: refused before the body is buffered (B-5).
  const signature = request.headers.get('stripe-signature');
  if (!signature) return Response.json({ error: 'invalid_signature' }, { status: 400 });
  let payload: string;
  try {
    payload = await readBodyCapped(request, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return Response.json({ error: 'payload_too_large' }, { status: 413 });
    }
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe_webhook_body_unreadable',
        name: e instanceof Error ? e.name : 'unknown',
      }),
    );
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  try {
    const outcome = await handleStripeWebhook(deps, payload, signature);
    return Response.json({ received: true, outcome });
  } catch (e) {
    if (e instanceof WebhookSignatureError) {
      return Response.json({ error: 'invalid_signature' }, { status: 400 });
    }
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe_webhook_failed',
        name: e instanceof Error ? e.name : 'unknown',
      }),
    );
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
