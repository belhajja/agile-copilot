import { fetchNoRedirect } from '@agile/net';
import type { Client, SendRequestOptions } from 'jira.js/core';

export type JiraAuth =
  | { type: 'basic'; email: string; apiToken: string }
  | { type: 'bearer'; token: string };

export interface NoRedirectClientConfig {
  host: string;
  auth: JiraAuth;
  /**
   * 'strict' (default) throws SchemaMismatchError when a body does not match jira.js's schema.
   * 'lenient' returns the parsed JSON as-is: sync code validates with its own, looser schemas, so
   * a field Atlassian added or renamed does not stop a whole sync.
   */
  schemaValidation?: 'strict' | 'lenient';
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number;
  /** Largest accepted response body (default 20 MB). */
  maxResponseBytes?: number;
  /** Redirect-refusing fetch to use (default fetchNoRedirect; createOutboundFetch pins DNS too). */
  fetch?: typeof fetch;
}

export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** The response body is larger than the allowed maximum. */
export class ResponseTooLargeError extends Error {
  override name = 'ResponseTooLargeError';
  constructor() {
    super('Jira response is too large.');
  }
}

/** Reads the body as text, refusing more than `max` bytes (Content-Length, then while streaming). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A non-2xx answer from Jira. `retryAfterMs` is set when Jira sent a usable Retry-After header. */
export class JiraHttpError extends Error {
  override name = 'JiraHttpError';
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Jira request failed with HTTP ${status}`);
  }
}

/** The stored credential cannot be sent as a header. The message never contains the credential. */
export class InvalidCredentialsError extends Error {
  override name = 'InvalidCredentialsError';
  constructor() {
    super('The stored Jira credentials contain invalid characters.');
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Same encoding as jira.js's own client: arrays repeat the key, objects are JSON, nullish is skipped. */
function appendSearchParams(url: URL, params: Record<string, unknown> | undefined) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
      }
    } else if (typeof value === 'object') {
      url.searchParams.set(key, JSON.stringify(value));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

/**
 * jira.js v6 `Client` that never follows redirects. jira.js's own client calls global `fetch` with
 * `redirect: 'follow'` and exposes no option for it, which would let a public host bounce the
 * server — with our credentials — to an internal address (SSRF). A 3xx surfaces as
 * RedirectBlockedError (`status` set), any other non-2xx as JiraHttpError.
 */
export function createNoRedirectClient(config: NoRedirectClientConfig): Client {
  const authorization =
    config.auth.type === 'basic'
      ? `Basic ${Buffer.from(`${config.auth.email}:${config.auth.apiToken}`).toString('base64')}`
      : `Bearer ${config.auth.token}`;
  const host = config.host.replace(/\/+$/, '');
  return {
    async sendRequest<T>(options: SendRequestOptions<T>): Promise<T> {
      const url = new URL(host + (options.url.startsWith('/') ? options.url : `/${options.url}`));
      appendSearchParams(url, options.searchParams);
      const headers = new Headers(options.headers);
      headers.set('Accept', 'application/json');
      const hasBody = options.body !== undefined && options.body !== null;
      if (hasBody) headers.set('Content-Type', 'application/json');
      // Set last, case-insensitively: a caller header can never replace our credentials.
      try {
        headers.set('Authorization', authorization);
      } catch {
        // undici's message quotes the offending value, i.e. the credential: drop it, no `cause`.
        throw new InvalidCredentialsError();
      }
      const res = await (config.fetch ?? fetchNoRedirect)(url, {
        method: options.method ?? 'GET',
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new JiraHttpError(res.status, parseRetryAfter(res.headers.get('retry-after')));
      }
      const text = await readCapped(res, config.maxResponseBytes ?? MAX_RESPONSE_BYTES);
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw Object.assign(new Error('Response was not JSON'), { name: 'SchemaMismatchError' });
      }
      if (options.schema && data !== undefined && config.schemaValidation !== 'lenient') {
        const parsed = options.schema.safeParse(data);
        if (!parsed.success) {
          throw Object.assign(new Error('Response did not match the schema'), {
            name: 'SchemaMismatchError',
          });
        }
        return parsed.data;
      }
      return data as T;
    },
  };
}
