import { Atlassian } from 'arctic';
import { z } from 'zod';

/** Classic Jira scopes + Jira Software (agile) granular scopes needed for boards/sprints in Phase 2. */
export const ATLASSIAN_SCOPES = [
  'read:jira-work',
  'read:jira-user',
  'write:jira-work',
  'read:board-scope:jira-software',
  'read:sprint:jira-software',
  'offline_access',
] as const;

export interface AtlassianTokens {
  accessToken(): string;
  refreshToken(): string;
  accessTokenExpiresAt(): Date;
}

export interface AtlassianOAuthClient {
  createAuthorizationURL(state: string, scopes: string[]): URL;
  validateAuthorizationCode(code: string): Promise<AtlassianTokens>;
  refreshAccessToken(refreshToken: string): Promise<AtlassianTokens>;
}

export function createAtlassianOAuth(cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): AtlassianOAuthClient {
  return new Atlassian(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

export interface AtlassianSite {
  id: string;
  url: string;
  name: string;
}

const resources = z.array(
  z.object({
    id: z.string(),
    url: z.string(),
    name: z.string(),
    scopes: z.array(z.string()).default([]),
  }),
);

export async function listAccessibleJiraSites(
  accessToken: string,
  opts: { apiBase?: string } = {},
): Promise<AtlassianSite[]> {
  const res = await fetch(
    `${opts.apiBase ?? 'https://api.atlassian.com'}/oauth/token/accessible-resources`,
    {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      // Never follow redirects: a bearer token must not be replayed to another host.
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`accessible-resources failed with HTTP ${res.status}`);
  }
  return resources
    .parse(await res.json())
    .filter((s) => s.scopes.some((scope) => scope.endsWith(':jira-work')))
    .map(({ id, url, name }) => ({ id, url, name }));
}
