import type { DeliveryCode } from './codes';

export type { DeliveryCode } from './codes';

/** A delivery that failed. Fixed message; the code (and HTTP status, if any) is what is stored. */
export class DeliveryError extends Error {
  override name = 'DeliveryError';
  constructor(
    readonly code: DeliveryCode,
    readonly status?: number,
  ) {
    super(`Delivery failed (${code})`);
  }
}

/**
 * The caller's signal stopped a delivery (the worker is shutting down). Not a delivery failure:
 * nothing is said about the channel, and the message may or may not have gone out.
 */
export class DeliveryInterruptedError extends Error {
  override name = 'DeliveryInterruptedError';
  constructor() {
    super('Delivery interrupted');
  }
}

/** Rejects with `DeliveryInterruptedError` once `signal` aborts (never, without a signal). */
export function whenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new DeliveryInterruptedError());
    signal.addEventListener('abort', () => reject(new DeliveryInterruptedError()), { once: true });
  });
}
