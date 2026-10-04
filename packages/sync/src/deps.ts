import type { ConnectionDeps } from '@agile/connections';
import type {
  AtlassianOAuthClient,
  DataSourceOptions,
  JiraCredentialsInput,
  JiraDataSource,
  JiraFailureCode,
  RetryOptions,
} from '@agile/jira';

export interface SyncDeps extends ConnectionDeps {
  /** Atlassian OAuth client, needed to refresh "Connect with Atlassian" tokens. */
  oauth?: AtlassianOAuthClient;
  /** Swap the Jira client (tests). */
  createSource?: (creds: JiraCredentialsInput, opts: DataSourceOptions) => JiraDataSource;
  retry?: RetryOptions;
  now?: () => Date;
  /**
   * Aborts a running sync (pg-boss job signal, worker shutdown): Jira requests in flight and
   * Retry-After waits end at once; the run stops with `interrupted`.
   */
  signal?: AbortSignal;
  /** The run's own deadline (default `RUN_DEADLINE_MS`); tests shorten it. */
  runDeadlineMs?: number;
  /** Called with every failure the sync turns into a stored code (log `e.name`, never `e.message`). */
  onError?: (error: unknown, code: SyncFailureCode) => void;
}

export type SyncFailureCode =
  | JiraFailureCode
  | 'not_found'
  | 'no_boards'
  | 'already_running'
  | 'jira_paging'
  | 'oauth_expired'
  | 'oauth_unavailable'
  | 'interrupted'
  | 'timed_out'
  | 'workspace_busy'
  | 'board_query_rejected'
  | 'board_not_found';

interface CodeBehaviour {
  /** Only a user can fix it: the scheduled tick skips the connection until a manual "Sync now". */
  permanent: boolean;
  /** It would hit every board (credentials, network, rate limit): the whole run stops at once. */
  connectionWide: boolean;
  /** Worth retrying with backoff (pg-boss retryLimit). */
  retryable: boolean;
}

const code = (permanent: boolean, connectionWide: boolean, retryable = false): CodeBehaviour => ({
  permanent,
  connectionWide,
  retryable,
});

/** How the sync reacts to each failure code. Single source of truth for the run and the queue. */
export const SYNC_FAILURE_CODES: Readonly<Record<SyncFailureCode, CodeBehaviour>> = {
  unauthorized: code(true, true),
  forbidden: code(true, true),
  oauth_expired: code(true, true),
  oauth_unavailable: code(true, true),
  blocked_url: code(true, true),
  not_found: code(false, true),
  rate_limited: code(false, true, true),
  unreachable: code(false, true, true),
  // The worker stopped mid-run (deploy, crash handler): the lease is released, a retry takes over.
  interrupted: code(false, true, true),
  // The run outlived its deadline (a very slow or hostile Jira): boards already read keep their
  // progress; the next scheduled sync tries again (no pg-boss retry: it would only repeat the wait).
  timed_out: code(false, true),
  // Another connection of the workspace is syncing (one at a time per workspace, F2): pg-boss
  // retries the job later. Never stored: the state is not touched.
  workspace_busy: code(false, true, true),
  board_query_rejected: code(false, false),
  board_not_found: code(false, false),
  jira_paging: code(false, false),
  not_jira: code(false, false),
  wrong_deployment: code(false, false),
  invalid_input: code(false, false),
  unknown: code(false, false),
  no_boards: code(false, false),
  already_running: code(false, false),
};

const codesWhere = (key: keyof CodeBehaviour) =>
  (Object.keys(SYNC_FAILURE_CODES) as SyncFailureCode[]).filter((c) => SYNC_FAILURE_CODES[c][key]);

/** Codes that end the whole run (the remaining boards are not tried). */
export const CONNECTION_WIDE_CODES: ReadonlySet<SyncFailureCode> = new Set(
  codesWhere('connectionWide'),
);
/** Codes the scheduled tick skips until a user acts. */
export const PERMANENT_CODES: readonly SyncFailureCode[] = codesWhere('permanent');
/** Codes pg-boss retries with backoff. */
export const RETRYABLE_CODES: ReadonlySet<SyncFailureCode> = new Set(codesWhere('retryable'));

export type SyncFailure = { ok: false; code: SyncFailureCode };

/** A failure with a stable code; the code (never the message) is what gets stored and shown. */
export class SyncError extends Error {
  override name = 'SyncError';
  constructor(readonly code: SyncFailureCode) {
    super(`Jira sync failed: ${code}`);
  }
}
