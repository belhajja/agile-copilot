import type { JiraToolInput, JiraToolName } from './catalog';

/** Executes allowlisted Jira tools for one connection. Inputs are already validated. */
export interface JiraToolBackend {
  readonly kind: 'mcp-atlassian' | 'rest';
  call<N extends JiraToolName>(name: N, input: JiraToolInput<N>): Promise<unknown>;
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
