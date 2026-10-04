import { checkOutboundUrl, type Resolver } from '@agile/net';
import { inferDeployment, normalizeCredentials } from './normalize';
import { probeJira } from './probe';
import type { JiraCredentials, JiraTestResult } from './types';

export interface TestConnectionOptions {
  allowedPrivateHosts: readonly string[];
  resolve?: Resolver;
  atlassianApiBase?: string;
}

/** Normalises input, applies the outbound URL policy, then verifies the credentials with Jira. */
export async function testJiraConnection(
  input: JiraCredentials,
  opts: TestConnectionOptions,
): Promise<JiraTestResult> {
  let creds: JiraCredentials;
  try {
    creds = normalizeCredentials(input);
  } catch {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'Enter the full Jira URL, e.g. https://jira.example.com',
    };
  }
  if (creds.kind !== 'datacenter_pat' && !creds.baseUrl.startsWith('https://')) {
    return { ok: false, code: 'invalid_input', message: 'Jira Cloud URLs must use https.' };
  }
  if (creds.kind === 'datacenter_pat' && inferDeployment(creds.baseUrl) === 'cloud') {
    return {
      ok: false,
      code: 'wrong_deployment',
      message: 'This is a Jira Cloud site. Use "Connect with Atlassian" or an API token.',
    };
  }
  if (creds.kind !== 'cloud_oauth') {
    const check = await checkOutboundUrl(creds.baseUrl, opts);
    if (!check.ok) {
      return {
        ok: false,
        code: 'blocked_url',
        message: check.reason,
        detail: { reason: check.code, host: check.host },
      };
    }
  }
  return probeJira(creds, { atlassianApiBase: opts.atlassianApiBase });
}
