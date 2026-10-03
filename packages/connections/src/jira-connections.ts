import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, type Keyring } from '@agile/crypto';
import { type Db, isUniqueViolation, jiraConnections, type Tx, withOrg } from '@agile/db';
import {
  type JiraCredentials,
  type JiraFailureCode,
  normalizeCredentials,
  testJiraConnection,
} from '@agile/jira';
import type { Resolver } from '@agile/net';
import { desc, eq } from 'drizzle-orm';
import { type Actor, assertCanManage } from './actor';
import { recordAudit } from './audit';
import { getOrgDek } from './vault';

export interface ConnectionDeps {
  db: Db;
  keyring: Keyring;
  allowedPrivateHosts: readonly string[];
  resolve?: Resolver;
  testJira?: typeof testJiraConnection;
  atlassianApiBase?: string;
}

export interface StoredJiraSecret {
  credentials: JiraCredentials;
  oauth?: { refreshToken: string; expiresAt: string };
}

export interface JiraConnectionView {
  id: string;
  name: string;
  deployment: 'cloud' | 'datacenter';
  authType: 'basic' | 'oauth' | 'pat';
  baseUrl: string;
  accountName: string | null;
  status: 'untested' | 'ok' | 'error';
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

export type ServiceFailure = {
  ok: false;
  code: JiraFailureCode | 'duplicate' | 'not_found';
  message: string;
};

const AUTH_TYPE = { cloud_basic: 'basic', cloud_oauth: 'oauth', datacenter_pat: 'pat' } as const;
const secretContext = (id: string) => `jira_connection:${id}`;
const notFound: ServiceFailure = { ok: false, code: 'not_found', message: 'Connection not found.' };

const toView = (r: typeof jiraConnections.$inferSelect): JiraConnectionView => ({
  id: r.id,
  name: r.name,
  deployment: r.deployment,
  authType: r.authType,
  baseUrl: r.baseUrl,
  accountName: r.accountName,
  status: r.status,
  lastError: r.lastError,
  lastCheckedAt: r.lastCheckedAt,
  createdAt: r.createdAt,
});

const runTest = (deps: ConnectionDeps, creds: JiraCredentials) =>
  (deps.testJira ?? testJiraConnection)(creds, {
    allowedPrivateHosts: deps.allowedPrivateHosts,
    resolve: deps.resolve,
    atlassianApiBase: deps.atlassianApiBase,
  });

export async function readSecret(
  tx: Tx,
  deps: ConnectionDeps,
  orgId: string,
  id: string,
  encrypted: string,
) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return JSON.parse(decryptSecret(dek, secretContext(id), encrypted)) as StoredJiraSecret;
}

export async function writeSecret(
  tx: Tx,
  deps: ConnectionDeps,
  orgId: string,
  id: string,
  secret: StoredJiraSecret,
) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return encryptSecret(dek, secretContext(id), JSON.stringify(secret));
}

export async function createJiraConnection(
  deps: ConnectionDeps,
  actor: Actor,
  input: {
    name: string;
    credentials: JiraCredentials;
    oauth?: StoredJiraSecret['oauth'];
    oauthGrantId?: string;
  },
): Promise<{ ok: true; connection: JiraConnectionView } | ServiceFailure> {
  assertCanManage(actor);
  let credentials: JiraCredentials;
  try {
    credentials = normalizeCredentials(input.credentials);
  } catch {
    return { ok: false, code: 'invalid_input', message: 'Enter the full Jira URL.' };
  }
  const test = await runTest(deps, credentials); // network call stays outside the transaction
  if (!test.ok) return test;

  const id = randomUUID();
  try {
    const row = await withOrg(deps.db, actor.orgId, async (tx) => {
      const secret = await writeSecret(tx, deps, actor.orgId, id, {
        credentials,
        oauth: input.oauth,
      });
      const [inserted] = await tx
        .insert(jiraConnections)
        .values({
          id,
          orgId: actor.orgId,
          name: input.name.trim(),
          deployment: test.deployment,
          authType: AUTH_TYPE[credentials.kind],
          baseUrl: credentials.baseUrl,
          cloudId: credentials.kind === 'cloud_oauth' ? credentials.cloudId : null,
          oauthGrantId: input.oauthGrantId ?? null,
          accountId: test.account.id,
          accountName: test.account.displayName,
          secret,
          status: 'ok',
          lastCheckedAt: new Date(),
          createdBy: actor.userId,
        })
        .returning();
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'jira_connection.created',
        targetType: 'jira_connection',
        targetId: id,
        metadata: {
          deployment: test.deployment,
          authType: AUTH_TYPE[credentials.kind],
          baseUrl: credentials.baseUrl,
        },
      });
      return inserted;
    });
    if (!row) throw new Error('Insert returned no row');
    return { ok: true, connection: toView(row) };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, code: 'duplicate', message: 'This Jira site is already connected.' };
    }
    throw e;
  }
}

export async function listJiraConnections(
  deps: ConnectionDeps,
  orgId: string,
): Promise<JiraConnectionView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraConnections).orderBy(desc(jiraConnections.createdAt)),
  );
  return rows.map(toView);
}

export async function loadJiraSecret(
  deps: ConnectionDeps,
  orgId: string,
  id: string,
): Promise<StoredJiraSecret | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(jiraConnections)
      .where(eq(jiraConnections.id, id))
      .limit(1);
    return row ? readSecret(tx, deps, orgId, id, row.secret) : null;
  });
}

export async function retestJiraConnection(
  deps: ConnectionDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true; connection: JiraConnectionView } | ServiceFailure> {
  assertCanManage(actor);
  const secret = await loadJiraSecret(deps, actor.orgId, id);
  if (!secret) return notFound;
  const test = await runTest(deps, secret.credentials);
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [updated] = await tx
      .update(jiraConnections)
      .set({
        status: test.ok ? 'ok' : 'error',
        lastError: test.ok ? null : test.code,
        lastCheckedAt: new Date(),
        ...(test.ok ? { accountName: test.account.displayName } : {}),
      })
      .where(eq(jiraConnections.id, id))
      .returning();
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_connection.retested',
      targetType: 'jira_connection',
      targetId: id,
      metadata: { ok: test.ok, ...(test.ok ? {} : { code: test.code }) },
    });
    return updated;
  });
  return row ? { ok: true, connection: toView(row) } : notFound;
}

export async function deleteJiraConnection(
  deps: ConnectionDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | ServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const deleted = await tx
      .delete(jiraConnections)
      .where(eq(jiraConnections.id, id))
      .returning({ id: jiraConnections.id });
    if (deleted.length === 0) return notFound;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_connection.deleted',
      targetType: 'jira_connection',
      targetId: id,
    });
    return { ok: true } as const;
  });
}
