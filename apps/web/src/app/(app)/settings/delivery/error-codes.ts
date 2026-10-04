/** Codes with a plain sentence under `delivery.errors` (not the nested `blocked` group). */
export const CHANNEL_ERROR_CODES = [
  'invalid_input',
  'duplicate',
  'insecure_transport',
  'blocked_url',
  'unreachable',
  'rejected',
  'timeout',
  'auth_failed',
  'invalid_channel',
  'forbidden_role',
  'not_found',
] as const;

export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

export const isChannelErrorCode = (code: string | null): code is ChannelErrorCode =>
  code !== null && (CHANNEL_ERROR_CODES as readonly string[]).includes(code);
