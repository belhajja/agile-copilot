import { randomUUID } from 'node:crypto';
import { jiraConnections, withOrg } from '@agile/db';
import {
  type AtlassianOAuthClient,
  type JiraCredentials,
  listAccessibleJiraSites,
  normalizeBaseUrl,
} from '@agile/jira';
import { and, eq, sql } from 'drizzle-orm';
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
  /** Deadline for each token request to Atlassian (default 15 s); injectable for tests. */
  oauthTimeoutMs?: number;
};

export class OAuthTimeoutError extends Error {
  override name = 'OAuthTimeoutError';
  constructor() {
    super('Atlassian token request timed out');
  }
}

/** arctic's token requests carry no AbortSignal, so enforce a deadline ourselves. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OAuthTimeoutError()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const DEADLINE_MS = 15_000;
const REFRESH_WINDOW_MS = 60_000;

export async function completeJiraOAuth(
  deps: OAuthDeps,
  actor: Actor,
  code: string,
): Promise<
  | { ok: true; created: number; updated: number }
  | { ok: false; code: 'oauth_failed' | 'oauth_no_sites' }
> {
  assertCanManage(actor);
  const ms = deps.oauthTimeoutMs ?? DEADLINE_MS;
  let tokens: Awaited<ReturnType<AtlassianOAuthClient['validateAuthorizationCode']>>;
  let sites: Awaited<ReturnType<typeof listAccessibleJiraSites>>;
  try {
    tokens = await withDeadline(deps.oauth.validateAuthorizationCode(code), ms);
    sites = await (deps.listSites ?? listAccessibleJiraSites)(tokens.accessToken());
  } catch {
    return { ok: false, code: 'oauth_failed' };
  }
  if (sites.length === 0) return { ok: false, code: 'oauth_no_sites' };

  // Atlassian rotates one refresh token per consent, so all sites of this consent share a grant.
  const oauthGrantId = randomUUID();
  const oauth = {
    refreshToken: tokens.refreshToken(),
    expiresAt: tokens.accessTokenExpiresAt().toISOString(),
  };
  let created = 0;
  let updated = 0;
  for (const site of sites) {
    const credentials: JiraCredentials = {
      kind: 'cloud_oauth',
      baseUrl: site.url,
      cloudId: site.id,
      accessToken: tokens.accessToken(),
    };
    const result = await createJiraConnection(deps, actor, {
      name: site.name,
      credentials,
      oauth,
      oauthGrantId,
    });
    if (result.ok) {
      created++;
    } else if (result.code === 'duplicate') {
      if (
        await reconnect(deps, actor, normalizeBaseUrl(site.url), credentials, oauth, oauthGrantId)
      ) {
        updated++;
      }
    }
  }
  return { ok: true, created, updated };
}

/** Replaces the dead tokens of an existing OAuth connection; API-token connections are left alone. */
async function reconnect(
  deps: ConnectionDeps,
  actor: Actor,
  baseUrl: string,
  credentials: JiraCredentials,
  oauth: { refreshToken: string; expiresAt: string },
  oauthGrantId: string,
): Promise<boolean> {
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(jiraConnections)
      .where(and(eq(jiraConnections.orgId, actor.orgId), eq(jiraConnections.baseUrl, baseUrl)))
      .for('update');
    if (row?.authType !== 'oauth') return false;
    const secret = await writeSecret(tx, deps, actor.orgId, row.id, {
      credentials: { ...credentials, baseUrl },
      oauth,
    });
    await tx
      .update(jiraConnections)
      .set({
        secret,
        oauthGrantId,
        status: 'ok',
        lastError: null,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jiraConnections.id, row.id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_connection.token_refreshed',
      targetType: 'jira_connection',
      targetId: row.id,
      metadata: { reason: 'reconnected' },
    });
    return true;
  });
}

/**
 * Returns usable credentials, refreshing an expiring OAuth token first. Atlassian rotates refresh
 * tokens (one per consent, shared by every site of that consent), so refreshes are serialised per
 * grant with an advisory lock plus row locks, and the rotated tokens are written to every sibling.
 */
export async function getFreshJiraCredentials(
  deps: OAuthDeps,
  orgId: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<JiraCredentials | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '20s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const [peek] = await tx
      .select({ grant: jiraConnections.oauthGrantId })
      .from(jiraConnections)
      .where(and(eq(jiraConnections.orgId, orgId), eq(jiraConnections.id, id)));
    if (!peek) return null;
    if (peek.grant) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`jira_grant:${peek.grant}`}))`);
    }
    const rows = await tx
      .select()
      .from(jiraConnections)
      .where(
        and(
          eq(jiraConnections.orgId, orgId),
          peek.grant ? eq(jiraConnections.oauthGrantId, peek.grant) : eq(jiraConnections.id, id),
        ),
      )
      .for('update');
    const target = rows.find((r) => r.id === id);
    if (!target) return null;
    const secret = await readSecret(tx, deps, orgId, id, target.secret);
    if (secret.credentials.kind !== 'cloud_oauth' || !secret.oauth) return secret.credentials;
    if (new Date(secret.oauth.expiresAt).getTime() - now().getTime() > REFRESH_WINDOW_MS) {
      return secret.credentials;
    }

    const tokens = await withDeadline(
      deps.oauth.refreshAccessToken(secret.oauth.refreshToken),
      deps.oauthTimeoutMs ?? DEADLINE_MS,
    );
    const rotated = {
      refreshToken: tokens.refreshToken(),
      expiresAt: tokens.accessTokenExpiresAt().toISOString(),
    };
    let result: JiraCredentials = secret.credentials;
    for (const row of rows) {
      const own = row.id === id ? secret : await readSecret(tx, deps, orgId, row.id, row.secret);
      if (own.credentials.kind !== 'cloud_oauth') continue;
      const credentials: JiraCredentials = {
        ...own.credentials,
        accessToken: tokens.accessToken(),
      };
      const encrypted = await writeSecret(tx, deps, orgId, row.id, { credentials, oauth: rotated });
      await tx
        .update(jiraConnections)
        .set({ secret: encrypted })
        .where(eq(jiraConnections.id, row.id));
      await recordAudit(tx, {
        orgId,
        actorUserId: null,
        action: 'jira_connection.token_refreshed',
        targetType: 'jira_connection',
        targetId: row.id,
      });
      if (row.id === id) result = credentials;
    }
    return result;
  });
}
