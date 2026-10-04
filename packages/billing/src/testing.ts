import Stripe from 'stripe';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** stripe-mock (Stripe's official API mock), pinned by digest. */
export const STRIPE_MOCK_IMAGE =
  'stripe/stripe-mock:v0.206.0@sha256:aeb96b83e87a893d2ac005e363ac01ffa6e59a5ad85b49c155dfc9129de02e78';

export async function startStripeMock(): Promise<{ url: string; stop: () => Promise<void> }> {
  const container: StartedTestContainer = await new GenericContainer(STRIPE_MOCK_IMAGE)
    .withExposedPorts(12111)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  return {
    url: `http://${container.getHost()}:${container.getMappedPort(12111)}`,
    stop: async () => void (await container.stop()),
  };
}

/** A webhook delivery as Stripe sends it: the JSON body and its `Stripe-Signature` header. */
export async function signedEvent(
  secret: string,
  event: {
    id: string;
    type: string;
    created: number;
    object: Record<string, unknown>;
    /** When the delivery was signed (unix seconds); now by default. */
    signedAt?: number;
  },
): Promise<{ payload: string; signature: string }> {
  const payload = JSON.stringify({
    id: event.id,
    object: 'event',
    type: event.type,
    created: event.created,
    api_version: Stripe.API_VERSION,
    livemode: false,
    data: { object: event.object },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    ...(event.signedAt ? { timestamp: event.signedAt } : {}),
  });
  return { payload, signature };
}
