import {
  BlockedAddressError,
  InsecureTransportError,
  isBlockedAddressError,
  isInsecureTransportError,
} from '@agile/net';
import { JiraHttpError } from './no-redirect-client';
import { errorRetryAfterMs, errorStatus } from './rate-limit';

/** A request failed before any HTTP status (network, timeout, oversized body). Only a code. */
export class JiraRequestError extends Error {
  override name = 'JiraRequestError';
  constructor(readonly code: string) {
    super(`Jira request failed (${code})`);
  }
}

const field = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;

/**
 * jira.js v5 wraps failures in an HttpException whose `cause` is the AxiosError, and that holds the
 * request config: the Authorization header (our PAT), URL and body. Keep only what callers need
 * (status, Retry-After, a network code) in a fresh error with no cause.
 */
export function sanitizeDataCenterError(e: unknown): Error {
  if (isBlockedAddressError(e)) return new BlockedAddressError('jira');
  if (isInsecureTransportError(e)) return new InsecureTransportError('jira');
  const status = errorStatus(e);
  if (status !== undefined) return new JiraHttpError(status, errorRetryAfterMs(e));
  const code = field(e, 'code') ?? field(field(e, 'cause'), 'code');
  return new JiraRequestError(
    typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'UNKNOWN',
  );
}
