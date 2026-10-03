import { jiraConnections, withOrg } from '@agile/db';
import {
  type AtlassianOAuthClient,
  type JiraCredentials,
  listAccessibleJiraSites,
} from '@agile/jira';
import { eq } from 'drizzle-orm';
import type { Actor } from './actor';
import { assertCanManage } from './actor';
import { recordAudit } from './audit';
import {
  type ConnectionDeps,
  createJiraConnection,
  readSecret,
  writeSecret,
} from './jira-connections';

type OAuthDeps = ConnectionDeps & {
  oauth: AtlassianOAuthClient;
  listSites?: typeof listAccessibleJiraSites;
};

const REFRESH_WINDOW_MS = 60_000;

export async function completeJiraOAuth(
  deps: OAuthDeps,
  actor: Actor,
  code: string,
): Promise<{ ok: true; created: number } | { ok: false; code: 'oauth_failed' | 'oauth_no_sites' }> {
  assertCanManage(actor);
  let tokens: Awaited<ReturnType<AtlassianOAuthClient['validateAuthorizationCode']>>;
  let sites: Awaited<ReturnType<typeof listAccessibleJiraSites>>;
  try {
    tokens = await deps.oauth.validateAuthorizationCode(code);
    sites = await (deps.listSites ?? listAccessibleJiraSites)(tokens.accessToken());
  } catch {
    return { ok: false, code: 'oauth_failed' };
  }
  if (sites.length === 0) return { ok: false, code: 'oauth_no_sites' };

  let created = 0;
  for (const site of sites) {
    const result = await createJiraConnection(deps, actor, {
      name: site.name,
      credentials: {
        kind: 'cloud_oauth',
        baseUrl: site.url,
        cloudId: site.id,
        accessToken: tokens.accessToken(),
      },
      oauth: {
        refreshToken: tokens.refreshToken(),
        expiresAt: tokens.accessTokenExpiresAt().toISOString(),
      },
    });
    if (result.ok) created++;
  }
  return { ok: true, created };
}

/**
 * Returns usable credentials, refreshing an expiring OAuth token first. Atlassian rotates refresh
 * tokens, so refreshes are serialised per connection with a row lock; later callers see the new token.
 */
export async function getFreshJiraCredentials(
  deps: OAuthDeps,
  orgId: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<JiraCredentials | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(jiraConnections)
      .where(eq(jiraConnections.id, id))
      .for('update');
    if (!row) return null;
    const secret = await readSecret(tx, deps, orgId, id, row.secret);
    if (secret.credentials.kind !== 'cloud_oauth' || !secret.oauth) return secret.credentials;
    if (new Date(secret.oauth.expiresAt).getTime() - now().getTime() > REFRESH_WINDOW_MS) {
      return secret.credentials;
    }

    const tokens = await deps.oauth.refreshAccessToken(secret.oauth.refreshToken);
    const credentials: JiraCredentials = {
      ...secret.credentials,
      accessToken: tokens.accessToken(),
    };
    const encrypted = await writeSecret(tx, deps, orgId, id, {
      credentials,
      oauth: {
        refreshToken: tokens.refreshToken(),
        expiresAt: tokens.accessTokenExpiresAt().toISOString(),
      },
    });
    await tx.update(jiraConnections).set({ secret: encrypted }).where(eq(jiraConnections.id, id));
    await recordAudit(tx, {
      orgId,
      actorUserId: null,
      action: 'jira_connection.token_refreshed',
      targetType: 'jira_connection',
      targetId: id,
    });
    return credentials;
  });
}
