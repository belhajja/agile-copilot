/**
 * Wraps a tool result as data for the model. Everything a tool returns can carry text written by
 * Jira users (summaries, comments, descriptions), so it is framed in one fixed envelope that the
 * system prompt declares untrusted, and every `<` is escaped inside the payload so content can
 * neither end the envelope early nor open another one (`<skill>`) and pose as instructions.
 *
 * Client-safe (no Node APIs): the web UI imports `@agile/agent/untrusted` to read tool outputs.
 */
export function asUntrustedData(source: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    // BigInt or a cycle: the engine's message names the culprit; never pass it on.
    throw new UntrustedDataError();
  }
  // Every "<" becomes "\u003c": the same JSON once parsed (it can only occur inside strings), but
  // no tag of any spelling can open or close inside the envelope: `</data>`, `<skill …>`, or a
  // variant with zero-width or odd characters a special case would miss (P4-R17, P4-R27).
  const safe = (json ?? 'null').replace(/</g, '\\u003c');
  return `<data source="${source.replace(/[^a-z0-9_]/gi, '')}">\n${safe}\n</data>`;
}

/** A tool result that cannot be framed as JSON (BigInt, cycle). Fixed message, stable code. */
export class UntrustedDataError extends Error {
  override name = 'UntrustedDataError';
  readonly code = 'unserializable';
  constructor() {
    super('The tool result could not be serialised.');
  }
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
