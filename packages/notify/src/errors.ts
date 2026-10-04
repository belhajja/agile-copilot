export type DeliveryCode =
  | 'blocked_url'
  | 'insecure_transport'
  | 'unreachable'
  | 'rejected'
  | 'timeout'
  | 'auth_failed';

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
