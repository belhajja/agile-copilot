/**
 * Picks a message code out of untrusted input (a query parameter). Only codes in `allowed` pass,
 * compared by value, so keys of Object.prototype or of the message catalog never resolve;
 * anything else, including an array, is `unknown`.
 */
export function pickCode(value: unknown, allowed: readonly string[]): string {
  return allowedCode(value, allowed) ?? 'unknown';
}

/**
 * `value` when it is one of `allowed` (compared by value), else null: for message keys built from
 * input we do not control (a query parameter, a model's tool name, Jira data). Never `t.has` on
 * such input: prototype keys and message namespaces pass it.
 */
export function allowedCode<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Why an outbound URL was refused (`blocked_url` with a reason): one sentence each under
 * `llm.errors.blocked`, `jira.errors.blocked` and `delivery.errors.blocked`.
 */
export const BLOCKED_REASONS = [
  'invalid_url',
  'scheme',
  'credentials',
  'blocked_host',
  'localhost',
  'private_address',
  'unresolvable',
] as const;
