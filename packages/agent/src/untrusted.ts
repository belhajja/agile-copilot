/**
 * Wraps a tool result as data for the model. Everything a tool returns can carry text written by
 * Jira users (summaries, comments, descriptions), so it is framed in one fixed envelope that the
 * system prompt declares untrusted, and the closing tag is escaped inside the payload so content
 * cannot end the envelope early and pose as instructions.
 *
 * Client-safe (no Node APIs): the web UI imports `@agile/agent/untrusted` to read tool outputs.
 */
export function asUntrustedData(source: string, value: unknown): string {
  const json =
    typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'null');
  // `<\/data` is still valid JSON for "</data", but no longer closes the envelope.
  const safe = json.replace(/<\/(data)/gi, '<\\/$1');
  return `<data source="${source.replace(/[^a-z0-9_]/gi, '')}">\n${safe}\n</data>`;
}

/** The envelope `asUntrustedData` produces: group 1 is the source, group 2 the JSON payload. */
export const UNTRUSTED_ENVELOPE = /^<data source="([a-z0-9_]*)">\n([\s\S]*)\n<\/data>$/i;

/** Reads an `asUntrustedData` envelope back; null when the text is not one (or not JSON). */
export function parseUntrustedData(text: string): { source: string; value: unknown } | null {
  const match = UNTRUSTED_ENVELOPE.exec(text);
  if (!match) return null;
  try {
    return { source: match[1] ?? '', value: JSON.parse(match[2] ?? '') };
  } catch {
    return null;
  }
}
