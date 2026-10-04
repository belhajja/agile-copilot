import { parseUntrustedData } from '@agile/agent/untrusted';

/**
 * Tool results and errors as the agent stores them: JSON framed in the `<data source="…">`
 * envelope (`asUntrustedData`). Read here with the agent's own parser, never a copy of its regex.
 */

/** The JSON inside the envelope, pretty-printed for people; anything else as it is. */
export function readableOutput(output: unknown): string {
  if (typeof output !== 'string') return JSON.stringify(output, null, 2) ?? '';
  const parsed = parseUntrustedData(output);
  return parsed ? JSON.stringify(parsed.value, null, 2) : output;
}

const CODE = /\(([a-z_]+)\)\.$/;

/**
 * A failed tool call: the fixed sentence (`… failed (code).`), its code, and, for an ambiguous
 * assignee, the names of the people Jira matched (the envelope that follows the sentence).
 */
export function readToolError(errorText: string | undefined): {
  code: string | undefined;
  text: string;
  candidates: string[];
} {
  const [first = '', ...rest] = (errorText ?? '').split('\n');
  const text = first.trim();
  const data = parseUntrustedData(rest.join('\n'))?.value as { candidates?: unknown } | undefined;
  const candidates = Array.isArray(data?.candidates)
    ? data.candidates.flatMap((c) =>
        typeof c?.displayName === 'string' ? [c.displayName as string] : [],
      )
    : [];
  return { code: CODE.exec(text)?.[1], text, candidates };
}

/** The person a `jira_assign_issue` result names (`assignee: { id, displayName }`). */
export function assignedTo(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const value = parseUntrustedData(output)?.value as
    | { assignee?: { displayName?: unknown } }
    | undefined;
  const name = value?.assignee?.displayName;
  return typeof name === 'string' ? name : undefined;
}
