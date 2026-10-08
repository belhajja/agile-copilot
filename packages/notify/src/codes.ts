/**
 * Every code a delivery or a channel can fail with: the web UI translates each one (EN/FR tests
 * read these lists). Client-safe (no imports): the web UI imports `@agile/notify/codes`.
 */

/** Why a delivery (email or webhook post) failed. */
export const DELIVERY_CODES = [
  'blocked_url',
  'insecure_transport',
  /** An SMTP port other than 25, 465, 587 or 2525 (off this machine). */
  'blocked_port',
  'unreachable',
  'rejected',
  'timeout',
  'auth_failed',
  /** The stored channel cannot be decrypted or has the wrong shape (a corrupt row). */
  'invalid_channel',
] as const;
export type DeliveryCode = (typeof DELIVERY_CODES)[number];

/** Why saving, testing or deleting a delivery channel was refused. */
export const CHANNEL_FAILURE_CODES = [
  'invalid_input',
  'duplicate',
  'not_found',
  ...DELIVERY_CODES,
] as const;
export type ChannelFailureCode = (typeof CHANNEL_FAILURE_CODES)[number];
