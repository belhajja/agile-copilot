const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * `<base>/browse/<KEY>` on a Jira site, or null when the base is not an http(s) URL or the text
 * is not an issue key. The base keeps its path (Data Center sites can live under one).
 */
export function jiraBrowseUrl(base: string | null | undefined, key: string): string | null {
  if (!base || !ISSUE_KEY.test(key)) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}/browse/${encodeURIComponent(key)}`;
}
