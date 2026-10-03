import { createCloudClient } from 'jira.js';
import { Version2Client } from 'jira-js-v5';
import { mapJiraError } from './errors';
import type { JiraCredentials, JiraTestResult } from './types';

export interface ProbeOptions {
  /** Atlassian API gateway origin; overridable for tests. */
  atlassianApiBase?: string;
  timeoutMs?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms),
    ),
  ]);

async function probeCloud(
  c: Exclude<JiraCredentials, { kind: 'datacenter_pat' }>,
  opts: ProbeOptions,
): Promise<JiraTestResult> {
  const client =
    c.kind === 'cloud_basic'
      ? createCloudClient({
          host: c.baseUrl,
          auth: { type: 'basic', email: c.email, apiToken: c.apiToken },
        })
      : createCloudClient({
          host: `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${c.cloudId}`,
          auth: { type: 'bearer', token: c.accessToken },
        });
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
): Promise<JiraTestResult> {
  // jira.js v6 only speaks REST v3 (Cloud); DC uses v5's Version2Client. A PAT is sent as a bearer token.
  const client = new Version2Client({
    host: c.baseUrl,
    authentication: { oauth2: { accessToken: c.token } },
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
    const run = c.kind === 'datacenter_pat' ? probeDataCenter(c) : probeCloud(c, opts);
    return await withTimeout(run, opts.timeoutMs ?? 15_000);
  } catch (e) {
    return mapJiraError(e);
  }
}
