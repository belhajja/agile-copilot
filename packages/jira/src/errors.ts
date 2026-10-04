import { isBlockedAddressError } from '@agile/net';
import { isApiError, isNetworkError } from 'jira.js';
import type { JiraFailure } from './types';

const NETWORK_CODES =
  /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_NETWORK|ECONNABORTED|UND_ERR_\w+)$/;

const readField = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;

/** Maps jira.js v6 (fetch) and v5 (axios) errors to stable codes. Never echoes raw error text. */
export function mapJiraError(e: unknown): JiraFailure {
  if (isBlockedAddressError(e)) {
    return {
      ok: false,
      code: 'blocked_url',
      message: 'This Jira host now points to a private or reserved address.',
    };
  }
  const status = isApiError(e)
    ? e.status
    : (readField(e, 'status') ?? readField(readField(e, 'response'), 'status'));
  if (status === 401)
    return { ok: false, code: 'unauthorized', message: 'Jira rejected these credentials.' };
  if (status === 403)
    return {
      ok: false,
      code: 'forbidden',
      message: 'Jira refused access (invalid token or missing permission).',
    };
  if (typeof status === 'number' && status >= 300 && status < 400) {
    return { ok: false, code: 'not_jira', message: 'This URL did not answer like Jira.' };
  }
  if (status === 404)
    return { ok: false, code: 'not_jira', message: 'No Jira REST API found at this URL.' };
  if (status === 429)
    return {
      ok: false,
      code: 'rate_limited',
      message: 'Jira is rate limiting requests. Try again shortly.',
    };

  const code = readField(e, 'code') ?? readField(readField(e, 'cause'), 'code');
  if (isNetworkError(e) || (typeof code === 'string' && NETWORK_CODES.test(code))) {
    return { ok: false, code: 'unreachable', message: 'Could not reach this Jira server.' };
  }
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { ok: false, code: 'unreachable', message: 'Jira did not answer in time.' };
  }
  if (name === 'SchemaMismatchError' || name === 'SyntaxError') {
    return { ok: false, code: 'not_jira', message: 'This URL did not answer like Jira.' };
  }
  if (name === 'ZodError' || name === 'InvalidCredentialsError')
    return { ok: false, code: 'invalid_input', message: 'Some connection details are invalid.' };
  return { ok: false, code: 'unknown', message: 'Unexpected error while contacting Jira.' };
}
