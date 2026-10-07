import type { JiraDataSource } from '@agile/jira';

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const CHUNK = 50;

type Source = Pick<JiraDataSource, 'searchIssues'>;

/**
 * Looks up one batch of keys. Jira rejects the whole `key in (...)` search when one key is
 * missing or hidden from this account, so a failing batch is split in half and retried until
 * the bad key is alone; that key is then skipped (cosmetic: it keeps its key without a name).
 */
async function lookUp(source: Source, keys: readonly string[], names: Map<string, string>) {
  try {
    for await (const page of source.searchIssues(`key in (${keys.join(',')})`, ['summary'])) {
      for (const raw of page) {
        const summary = (raw.fields as { summary?: unknown }).summary;
        if (typeof summary === 'string' && summary.trim() !== '')
          names.set(raw.key, summary.trim());
      }
    }
  } catch {
    if (keys.length < 2) return;
    const half = Math.ceil(keys.length / 2);
    await lookUp(source, keys.slice(0, half), names);
    await lookUp(source, keys.slice(half), names);
  }
}

/**
 * Epic summaries by key, for Data Center's Epic Link (which holds only the key). Keys are checked
 * before they reach JQL. An epic deleted or hidden from this account only leaves its own name
 * out: the keys are stored anyway.
 */
export async function epicNames(
  source: Source,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const valid = [...new Set(keys)].filter((k) => ISSUE_KEY.test(k));
  const names = new Map<string, string>();
  for (let i = 0; i < valid.length; i += CHUNK) {
    await lookUp(source, valid.slice(i, i + CHUNK), names);
  }
  return names;
}
