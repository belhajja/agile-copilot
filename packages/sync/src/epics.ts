import type { JiraDataSource } from '@agile/jira';

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const CHUNK = 50;

/**
 * Epic summaries by key, for Data Center's Epic Link (which holds only the key). Keys are checked
 * before they reach JQL. A failing search (an epic deleted or hidden from this account) only
 * leaves its names out: the keys are stored anyway.
 */
export async function epicNames(
  source: Pick<JiraDataSource, 'searchIssues'>,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const valid = [...new Set(keys)].filter((k) => ISSUE_KEY.test(k));
  const names = new Map<string, string>();
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    try {
      for await (const page of source.searchIssues(`key in (${chunk.join(',')})`, ['summary'])) {
        for (const raw of page) {
          const summary = (raw.fields as { summary?: unknown }).summary;
          if (typeof summary === 'string' && summary.trim() !== '')
            names.set(raw.key, summary.trim());
        }
      }
    } catch {
      // Cosmetic: the issues keep their epic key without a name until the next sync.
    }
  }
  return names;
}
