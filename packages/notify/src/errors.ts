export type DeliveryCode =
  | 'blocked_url'
  | 'insecure_transport'
  | 'unreachable'
  | 'rejected'
  | 'timeout'
  | 'auth_failed'
  /** The stored channel cannot be decrypted or has the wrong shape (a corrupt row). */
  | 'invalid_channel';

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
