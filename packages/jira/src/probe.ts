import { createOutboundFetch, type OutboundPolicy, withDeadline } from '@agile/net';
import { createCloudClient } from 'jira.js';
import { Version2Client } from 'jira-js-v5';
import { mapJiraError } from './errors';
import { createNoRedirectClient } from './no-redirect-client';
import { pinnedRequestConfig } from './pinned-config';
import type { JiraCredentials, JiraTestResult } from './types';

export interface ProbeOptions {
  /** Atlassian API gateway origin; overridable for tests. */
  atlassianApiBase?: string;
  timeoutMs?: number;
  /** Pins connections to user-supplied hosts to addresses this policy allows (DNS rebinding). */
  outbound?: OutboundPolicy;
}

async function probeCloud(
  c: Exclude<JiraCredentials, { kind: 'datacenter_pat' }>,
  opts: ProbeOptions,
): Promise<JiraTestResult> {
  const client = createCloudClient(
    createNoRedirectClient(
      c.kind === 'cloud_basic'
        ? {
            host: c.baseUrl,
            auth: { type: 'basic', email: c.email, apiToken: c.apiToken },
            fetch: opts.outbound ? createOutboundFetch(opts.outbound) : undefined,
          }
        : {
            host: `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${c.cloudId}`,
            auth: { type: 'bearer', token: c.accessToken },
          },
    ),
  );
  const [me, info] = await Promise.all([
    client.myself.getCurrentUser(),
    client.serverInfo.getServerInfo(),
  ]);
  if (info.deploymentType !== 'Cloud') {
    return {
      ok: false,
      code: 'wrong_deployment',
      message: 'This is a Jira Server/Data Center site. Use a personal access token instead.',
    };
  }
  return {
    ok: true,
    deployment: 'cloud',
    version: info.version ?? null,
    account: { id: me.accountId ?? '', displayName: me.displayName ?? '' },
  };
}

async function probeDataCenter(
  c: Extract<JiraCredentials, { kind: 'datacenter_pat' }>,
  opts: ProbeOptions,
): Promise<JiraTestResult> {
  // jira.js v6 only speaks REST v3 (Cloud); DC uses v5's Version2Client. A PAT is sent as a bearer token.
  const client = new Version2Client({
    host: c.baseUrl,
    authentication: { oauth2: { accessToken: c.token } },
    // Never follow redirects: a public host could otherwise bounce us to an internal address (SSRF).
    baseRequestConfig: { maxRedirects: 0, ...pinnedRequestConfig(opts.outbound) },
  });
  const [me, info] = await Promise.all([
    client.myself.getCurrentUser(),
    client.serverInfo.getServerInfo(),
  ]);
  if (info.deploymentType === 'Cloud') {
    return {
      ok: false,
      code: 'wrong_deployment',
      message: 'This is a Jira Cloud site. Use "Connect with Atlassian" or an API token.',
    };
  }
  const dcUser = me as { key?: string; name?: string; displayName?: string };
  return {
    ok: true,
    deployment: 'datacenter',
    version: info.version ?? null,
    account: { id: dcUser.key ?? dcUser.name ?? '', displayName: dcUser.displayName ?? '' },
  };
}

/** Verifies credentials against Jira itself. No URL policy — callers use testJiraConnection. */
export async function probeJira(
  c: JiraCredentials,
  opts: ProbeOptions = {},
): Promise<JiraTestResult> {
  try {
    const run = c.kind === 'datacenter_pat' ? probeDataCenter(c, opts) : probeCloud(c, opts);
    return await withDeadline(run, opts.timeoutMs ?? 15_000);
  } catch (e) {
    return mapJiraError(e);
  }
}
