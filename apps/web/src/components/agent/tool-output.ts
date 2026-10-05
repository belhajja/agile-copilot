import { type ToolErrorCode, toolErrorCodeOf } from '@agile/agent/tool-errors';
import { parseUntrustedData } from '@agile/agent/untrusted';
import { SKILL_OUTPUTS, SKILL_TRIGGERS } from '@agile/skills/codes';
import { z } from 'zod';

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

/**
 * A failed tool call: the fixed sentence, its code (read with the agent's own parser), and, for
 * an ambiguous assignee, the names of the people Jira matched (the envelope after the sentence).
 */
export function readToolError(errorText: string | undefined): {
  code: ToolErrorCode | undefined;
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
  return { code: toolErrorCodeOf(text), text, candidates };
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

/** The board a `pin_widget` result pinned to (to link its dashboard); only a well-formed id. */
export function pinnedBoardId(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const value = parseUntrustedData(output)?.value as
    | { pinned?: unknown; boardId?: unknown }
    | undefined;
  return value?.pinned === true && z.uuid().safeParse(value.boardId).success
    ? (value.boardId as string)
    : undefined;
}

const suggestionSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(300),
  trigger: z.enum(SKILL_TRIGGERS),
  output: z.enum(SKILL_OUTPUTS),
  document: z.string().min(1),
});

/** A `suggest_skill` result: the proposed skill's settings and its SKILL.md. */
export type SkillSuggestion = z.output<typeof suggestionSchema>;

/** The stored `suggest_skill` result, or undefined for anything else (another tool, malformed). */
export function skillSuggestionOf(output: unknown): SkillSuggestion | undefined {
  if (typeof output !== 'string') return undefined;
  const parsed = parseUntrustedData(output);
  if (parsed?.source !== 'skill_suggestion') return undefined;
  const result = suggestionSchema.safeParse(parsed.value);
  return result.success ? result.data : undefined;
}

/**
 * The skill builder link for a suggestion, or undefined while the reply is still streaming: the
 * conversation only stores the tool call once the turn ends, so a link opened before then would
 * 404 in the builder.
 */
export function suggestionHref(
  conversationId: string,
  toolCallId: string,
  busy: boolean,
): string | undefined {
  if (busy) return undefined;
  return `/skills/new?from=${encodeURIComponent(conversationId)}&suggestion=${encodeURIComponent(toolCallId)}`;
}
