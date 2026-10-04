/**
 * Picks a message code out of untrusted input (a query parameter). Only codes in `allowed` pass,
 * compared by value, so keys of Object.prototype or of the message catalog never resolve;
 * anything else, including an array, is `unknown`.
 */
export function pickCode(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
}
