import type { JiraToolInput, JiraToolName } from './catalog';

/** Per-call options: `signal` cancels the call (e.g. the chat request was aborted). */
export interface JiraToolCallOptions {
  signal?: AbortSignal;
}

/**
 * Executes allowlisted Jira tools for one connection. Inputs are already validated. Each call has
 * one overall deadline (the backend's `timeoutMs`) covering every request it makes; an abort or
 * the deadline rejects with `JiraToolError('unavailable')`.
 */
export interface JiraToolBackend {
  readonly kind: 'mcp-atlassian' | 'rest';
  call<N extends JiraToolName>(
    name: N,
    input: JiraToolInput<N>,
    opts?: JiraToolCallOptions,
  ): Promise<unknown>;
}

/** The single signal of one backend call: its overall deadline, and the caller's signal if any. */
export function callSignal(totalMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(totalMs);
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
}

export type JiraToolErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'invalid_request'
  | 'ambiguous_user'
  | 'rate_limited'
  | 'unavailable'
  | 'blocked_url'
  | 'jira_error';

/** A person the model may pick instead (id = accountId on Cloud, username on Data Center). */
export interface JiraUserCandidate {
  id: string;
  displayName: string;
}

/**
 * A failed Jira tool call. The message is a fixed English sentence: never Jira's raw text.
 * `candidates` (at most 5, no emails) is set for `ambiguous_user`: Jira data, to be handed to the
 * model as untrusted data via `toData()`, never interpolated into the message.
 */
export class JiraToolError extends Error {
  override name = 'JiraToolError';
  readonly candidates?: readonly JiraUserCandidate[];
  constructor(
    readonly code: JiraToolErrorCode,
    opts?: { candidates?: readonly JiraUserCandidate[] },
  ) {
    super(`Jira tool failed: ${code}`);
    if (opts?.candidates?.length) this.candidates = opts.candidates;
  }

  /** The structured result to show the model (wrap it as untrusted data). */
  toData(): { error: JiraToolErrorCode; candidates?: readonly JiraUserCandidate[] } {
    return { error: this.code, ...(this.candidates ? { candidates: this.candidates } : {}) };
  }
}

/** HTTP status → stable code. */
export function codeForStatus(status: number): JiraToolErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'jira_error';
}

const JIRA_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MCP_UTC_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;

/**
 * A time as both backends show it: ISO 8601 UTC to the second. Reads Jira's
 * `2026-10-03T12:00:00.000+0200` and mcp-atlassian 0.23.1's `2026-10-03 10:00:00 UTC` (it formats
 * times in its container's zone, UTC in our deployments); any other text is passed on unchanged.
 */
export function isoTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const mcp = MCP_UTC_TIME.exec(v);
  const iso = mcp ? `${mcp[1]}T${mcp[2]}Z` : JIRA_TIME.test(v) ? v : null;
  const ms = iso ? Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : Number.NaN;
  return Number.isNaN(ms) ? v : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
