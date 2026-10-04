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
  | 'oauth_unavailable';

export type SyncFailure = { ok: false; code: SyncFailureCode };

/** A failure with a stable code; the code (never the message) is what gets stored and shown. */
export class SyncError extends Error {
  override name = 'SyncError';
  constructor(readonly code: SyncFailureCode) {
    super(`Jira sync failed: ${code}`);
  }
}
