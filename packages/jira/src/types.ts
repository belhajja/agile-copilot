import type { BlockedUrlReason } from '@agile/net';

export type JiraDeployment = 'cloud' | 'datacenter';

export type JiraCredentials =
  | { kind: 'cloud_basic'; baseUrl: string; email: string; apiToken: string }
  | { kind: 'cloud_oauth'; baseUrl: string; cloudId: string; accessToken: string }
  | { kind: 'datacenter_pat'; baseUrl: string; token: string };

export type JiraFailureCode =
  | 'invalid_input'
  | 'blocked_url'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_jira'
  | 'wrong_deployment'
  | 'rate_limited'
  | 'unreachable'
  | 'unknown';

/** `message` is English for logs; UIs translate `code` (and `detail` for blocked_url). */
export type JiraFailure = {
  ok: false;
  code: JiraFailureCode;
  message: string;
  detail?: { reason: BlockedUrlReason; host?: string };
};

export type JiraTestResult =
  | {
      ok: true;
      deployment: JiraDeployment;
      version: string | null;
      account: { id: string; displayName: string };
    }
  | JiraFailure;
