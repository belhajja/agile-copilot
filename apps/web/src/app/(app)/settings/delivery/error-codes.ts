import { CHANNEL_FAILURE_CODES } from '@agile/notify/codes';

/**
 * Codes with a plain sentence under `delivery.errors` (not the nested `blocked` group), derived
 * from the package's own list (M10): the channel refusals, and the role check and webhook test
 * outcome of the actions.
 */
export const CHANNEL_ERROR_CODES = [
  ...CHANNEL_FAILURE_CODES,
  'forbidden_role',
  // A webhook's test message failed (no detail, see actions.ts).
  'test_failed',
] as const;

export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

export const isChannelErrorCode = (code: string | null): code is ChannelErrorCode =>
  code !== null && (CHANNEL_ERROR_CODES as readonly string[]).includes(code);
