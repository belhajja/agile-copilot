import { fetchNoRedirect, isBlockedAddressError } from '@agile/net';
import type { ProbeFailureCode } from './probe';
import type { LlmConfig } from './providers';

export type ModelListFailureCode = ProbeFailureCode | 'not_supported';

export type ModelListResult =
  | { ok: true; models: string[] }
  | { ok: false; code: ModelListFailureCode; message: string };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** What `listModels` needs: a provider's key (and base URL/resource name as applicable), no model. */
export type LlmModelsConfig = DistributiveOmit<LlmConfig, 'model'>;

export interface ListModelsOpts {
  /**
   * Fetch to use (default: fetchNoRedirect). Callers pass createOutboundFetch here only for
   * openai_compatible's user-supplied base URL (pins DNS); fixed-host providers never need it in
   * production.
   */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_MODELS = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 50;
const DEFAULT_TIMEOUT_MS = 30_000;

const fail = (code: ModelListFailureCode, message: string): ModelListResult => ({
  ok: false,
  code,
  message,
});

class ModelsHttpError extends Error {
  override name = 'ModelsHttpError';
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const isRedirectBlocked = (e: unknown) => e instanceof Error && e.name === 'RedirectBlockedError';

/** Reads the body as text, refusing more than `max` bytes, without buffering past that point. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error('Response too large');
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
      await reader.cancel().catch(() => {});
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(
  url: string | URL,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ModelsHttpError(res.status);
  }
  const text = await readCapped(res, MAX_RESPONSE_BYTES);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Response was not JSON');
  }
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** OpenAI, Mistral and OpenAI-compatible all serve `GET {base}/models` -> `{ data: [{ id }] }`. */
async function listOpenAiLike(
  base: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[]> {
  const body = (await fetchJson(
    `${base.replace(/\/+$/, '')}/models`,
    authHeaders(apiKey),
    fetchImpl,
    timeoutMs,
  )) as { data?: { id?: unknown }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

/** Anthropic pages with after_id/has_more/last_id. */
async function listAnthropicModels(
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[]> {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES && ids.length < MAX_MODELS; page++) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '100');
    if (afterId) url.searchParams.set('after_id', afterId);
    const body = (await fetchJson(
      url,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      fetchImpl,
      timeoutMs,
    )) as { data?: { id?: unknown }[]; has_more?: boolean; last_id?: string | null };
    for (const m of body.data ?? []) if (typeof m.id === 'string') ids.push(m.id);
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }
  return ids;
}

/** Google pages with pageToken/nextPageToken; only models that support generateContent count. */
async function listGoogleModels(
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES && ids.length < MAX_MODELS; page++) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = (await fetchJson(url, { 'x-goog-api-key': apiKey }, fetchImpl, timeoutMs)) as {
      models?: { name?: unknown; supportedGenerationMethods?: unknown[] }[];
      nextPageToken?: string;
    };
    for (const m of body.models ?? []) {
      if (
        typeof m.name === 'string' &&
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent')
      ) {
        ids.push(m.name.replace(/^models\//, ''));
      }
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

function mapError(e: unknown): ModelListResult {
  if (isBlockedAddressError(e)) {
    return fail('blocked_url', 'This host now points to a private or reserved address.');
  }
  if (isRedirectBlocked(e)) {
    return fail('unreachable', 'The provider endpoint redirected elsewhere; use its final URL.');
  }
  if (e instanceof ModelsHttpError) {
    switch (e.status) {
      case 401:
        return fail('unauthorized', 'The provider rejected this API key.');
      case 403:
        return fail('forbidden', 'This key is not allowed to list models.');
      case 429:
        return fail(
          'rate_limited',
          'The provider is rate limiting this key, or it has no credit left.',
        );
      default:
        return fail('provider_error', `The provider returned HTTP ${e.status}.`);
    }
  }
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return fail('unreachable', 'The provider did not answer in time.');
  }
  if (e instanceof TypeError) return fail('unreachable', 'Could not reach the provider.');
  return fail('provider_error', 'Unexpected error from the provider.');
}

/** Unique ids, sorted alphabetically, capped at 500. */
function finalize(ids: string[]): string[] {
  return [...new Set(ids)].sort().slice(0, MAX_MODELS);
}

/**
 * Lists the models a provider key can use, for the "Load models" / "Change model" pickers.
 * Azure deployments are not listable with an API key. Never includes the key in the result or in
 * any error message.
 */
export async function listModels(
  config: LlmModelsConfig,
  opts: ListModelsOpts = {},
): Promise<ModelListResult> {
  if (config.provider === 'azure') {
    return fail('not_supported', 'Azure deployments cannot be listed with an API key.');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Fixed-host providers never receive opts.fetch in production (only openai_compatible's
  // user-supplied URL needs DNS pinning); tests use it to point a fixed host at a local mock.
  const fetchImpl = opts.fetch ?? fetchNoRedirect;
  try {
    let ids: string[];
    switch (config.provider) {
      case 'openai':
        ids = await listOpenAiLike(
          'https://api.openai.com/v1',
          config.apiKey,
          fetchImpl,
          timeoutMs,
        );
        break;
      case 'mistral':
        ids = await listOpenAiLike(
          'https://api.mistral.ai/v1',
          config.apiKey,
          fetchImpl,
          timeoutMs,
        );
        break;
      case 'openai_compatible':
        ids = await listOpenAiLike(config.baseUrl, config.apiKey, fetchImpl, timeoutMs);
        break;
      case 'anthropic':
        ids = await listAnthropicModels(config.apiKey, fetchImpl, timeoutMs);
        break;
      case 'google':
        ids = await listGoogleModels(config.apiKey, fetchImpl, timeoutMs);
        break;
    }
    return { ok: true, models: finalize(ids) };
  } catch (e) {
    return mapError(e);
  }
}
