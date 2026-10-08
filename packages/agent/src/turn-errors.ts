// Shared with the browser (`@agile/agent/turn-errors`): keep this file free of server imports.

/**
 * A reply that ended without an answer carries this part, stored with the reply, so the chat shows
 * why (translated by code) now and after a reload. The model never sees it.
 */
export const TURN_ERROR_PART = 'data-turn-error';

/** `turn_timeout`: the reply ran past its deadline and was stopped. */
export const TURN_ERROR_CODES = ['turn_timeout'] as const;
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];

export interface TurnErrorPart {
  type: typeof TURN_ERROR_PART;
  data: { code: TurnErrorCode };
}

/** The code of a stored turn error part; null for any other part (or an unknown code). */
export function turnErrorCode(part: { type: string; data?: unknown }): TurnErrorCode | null {
  if (part.type !== TURN_ERROR_PART) return null;
  const code = (part.data as { code?: unknown } | null | undefined)?.code;
  return TURN_ERROR_CODES.find((c) => c === code) ?? null;
}
