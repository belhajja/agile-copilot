import {
  getFreshJiraCredentials,
  loadJiraSecret,
  OAuthRefreshError,
  OAuthTimeoutError,
} from '@agile/connections';
import { jiraConnections, withOrg } from '@agile/db';
import {
  createJiraDataSource,
  type JiraCredentials,
  type JiraCredentialsInput,
  type JiraDataSource,
} from '@agile/jira';
import { checkOutboundUrl } from '@agile/net';
import { eq } from 'drizzle-orm';
import { type SyncDeps, SyncError } from './deps';

/**
 * Usable credentials for a stored connection. OAuth tokens are refreshed when due (serialised per
 * grant by getFreshJiraCredentials); for the other kinds the URL policy is checked again, because
 * the host's DNS may have changed since the connection was tested.
 */
export async function resolveCredentials(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<JiraCredentials> {
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({ authType: jiraConnections.authType, baseUrl: jiraConnections.baseUrl })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId)),
  );
  if (!row) throw new SyncError('not_found');
  if (row.authType === 'oauth') {
    if (!deps.oauth) throw new SyncError('oauth_unavailable');
    try {
      const creds = await getFreshJiraCredentials(
        { ...deps, oauth: deps.oauth },
        orgId,
        connectionId,
      );
      if (!creds) throw new SyncError('not_found');
      return creds;
    } catch (e) {
      if (e instanceof OAuthRefreshError || e instanceof OAuthTimeoutError) {
        throw new SyncError('oauth_expired');
      }
      throw e;
    }
  }
  const check = await checkOutboundUrl(row.baseUrl, deps);
  // A DNS failure is usually transient (resolver hiccup, VPN down): retry it, don't block the
  // connection as a policy violation that needs a user action.
  if (!check.ok) {
    throw new SyncError(
      check.code === 'unresolvable'
        ? 'unreachable'
        : check.code === 'insecure_transport'
          ? 'insecure_transport'
          : 'blocked_url',
    );
  }
  const secret = await loadJiraSecret(deps, orgId, connectionId);
  if (!secret) throw new SyncError('not_found');
  return secret.credentials;
}

export async function openDataSource(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<JiraDataSource> {
  const creds = await resolveCredentials(deps, orgId, connectionId);
  // OAuth access tokens expire mid-sync: hand the data source a provider that refreshes when due.
  const input: JiraCredentialsInput =
    creds.kind === 'cloud_oauth' ? () => resolveCredentials(deps, orgId, connectionId) : creds;
  return (deps.createSource ?? createJiraDataSource)(input, {
    atlassianApiBase: deps.atlassianApiBase,
    retry: deps.retry,
    // The run's signal (job, worker stop, run deadline) also ends requests and waits in flight.
    signal: deps.signal,
    // resolveCredentials checked the URL; pin every connection to an address passing the same rule.
    outbound: { allowedPrivateHosts: deps.allowedPrivateHosts, resolve: deps.resolve },
  });
}
