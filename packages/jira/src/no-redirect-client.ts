import type { SendRequestOptions } from 'jira.js/core';

type Auth = { type: 'basic'; email: string; apiToken: string } | { type: 'bearer'; token: string };

/**
 * Minimal jira.js v6 `Client` that never follows redirects. jira.js's own client calls global
 * `fetch` with `redirect: 'follow'` and exposes no option for it, which would let a public host
 * bounce the server to an internal address (SSRF). Any 3xx surfaces as an error carrying `status`.
 */
export function createNoRedirectClient(config: { host: string; auth: Auth }) {
  const authorization =
    config.auth.type === 'basic'
      ? `Basic ${Buffer.from(`${config.auth.email}:${config.auth.apiToken}`).toString('base64')}`
      : `Bearer ${config.auth.token}`;
  return {
    async sendRequest<T>(options: SendRequestOptions<T>): Promise<T> {
      const url = new URL(
        config.host.replace(/\/+$/, '') +
          (options.url.startsWith('/') ? options.url : `/${options.url}`),
      );
      for (const [k, v] of Object.entries(options.searchParams ?? {}))
        url.searchParams.set(k, String(v));
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json', Authorization: authorization, ...options.headers },
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw Object.assign(new Error(`Request failed: ${res.status}`), { status: res.status });
      }
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw Object.assign(new Error('Response was not JSON'), { name: 'SchemaMismatchError' });
      }
      if (options.schema && data !== undefined) {
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
