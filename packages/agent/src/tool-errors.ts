import type { JiraToolErrorCode } from '@agile/jira-tools';
import type { SyncFailureCode } from '@agile/sync';

/**
 * Every code a failed tool call can show the model and the user, and the fixed sentence for it.
 * The UI reads the code back with `toolErrorCodeOf` (never by copying the pattern) and translates
 * it; the tests check that both locales have a text for each code.
 *
 * Client-safe (type imports only): the web UI imports `@agile/agent/tool-errors`.
 */

/** `JiraToolError` codes (both Jira tool backends). */
const JIRA = [
  'not_found',
  'forbidden',
  'unauthorized',
  'invalid_request',
  'ambiguous_user',
  'rate_limited',
  'unavailable',
  'blocked_url',
  'jira_error',
  'unknown_outcome',
] as const satisfies readonly JiraToolErrorCode[];

/** What `resolveCredentials` throws for a connection (deleted, OAuth, network, URL policy). */
export const CREDENTIAL_ERROR_CODES = [
  'not_found',
  'oauth_expired',
  'oauth_unavailable',
  'unreachable',
  'blocked_url',
] as const satisfies readonly SyncFailureCode[];

/** The agent's own refusals. */
const AGENT = [
  /** The write had no matching approved row (never approved, or already used). */
  'approval_required',
  /** Approved, but the turn failed before it was sent (P3-R26). */
  'not_executed',
  /** The user's role no longer allows Jira tools. */
  'forbidden_role',
  /** A tool result that cannot be framed as JSON. */
  'unserializable',
] as const;

/** The analytics MCP server's failures (`@agile/analytics-mcp`). */
export const ANALYTICS_ERROR_CODES = ['internal_error', 'unknown_board', 'invalid_params'] as const;

export const TOOL_ERROR_CODES = Object.freeze([
  ...new Set([...JIRA, ...CREDENTIAL_ERROR_CODES, ...AGENT, ...ANALYTICS_ERROR_CODES]),
]) as readonly ToolErrorCode[];

export type ToolErrorCode =
  | (typeof JIRA)[number]
  | (typeof CREDENTIAL_ERROR_CODES)[number]
  | (typeof AGENT)[number]
  | (typeof ANALYTICS_ERROR_CODES)[number];

// Every JiraToolErrorCode is listed above (a new backend code fails the typecheck here).
type MissingJiraCode = Exclude<JiraToolErrorCode, (typeof JIRA)[number]>;
const everyJiraCodeListed: [MissingJiraCode] extends [never] ? true : MissingJiraCode = true;
void everyJiraCodeListed;

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];
export type AnalyticsErrorCode = (typeof ANALYTICS_ERROR_CODES)[number];

/** Codes whose sentence tells the user what to do instead of naming the failure. */
const PLAIN: Partial<Record<ToolErrorCode, string>> = {
  not_executed: 'The change was approved but not sent. Ask again to retry.',
  unknown_outcome: 'The change may or may not have reached Jira. Check Jira before asking again.',
  approval_required: 'This Jira change was not approved by the user (approval_required).',
};

/** The fixed sentence for a tool failure (what the model reads and the stored history keeps). */
export function toolErrorText(code: ToolErrorCode, tool: 'jira' | 'analytics' = 'jira'): string {
  return (
    PLAIN[code] ??
    `${tool === 'analytics' ? 'The analytics tool failed' : 'The Jira request failed'} (${code}).`
  );
}

const CODE_AT_END = /\(([a-z_]+)\)\.$/;
const isToolErrorCode = (v: unknown): v is ToolErrorCode =>
  typeof v === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(v);

/** The code of a stored tool error (its first line is a `toolErrorText` sentence); else undefined. */
export function toolErrorCodeOf(errorText: string | undefined): ToolErrorCode | undefined {
  const first = (errorText ?? '').split('\n', 1)[0]?.trim() ?? '';
  const plain = (Object.keys(PLAIN) as ToolErrorCode[]).find((c) => PLAIN[c] === first);
  if (plain) return plain;
  const code = CODE_AT_END.exec(first)?.[1];
  return isToolErrorCode(code) ? code : undefined;
}
