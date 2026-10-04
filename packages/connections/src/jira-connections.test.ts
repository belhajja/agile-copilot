import { auditLog, jiraConnections } from '@agile/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  type ConnectionDeps,
  createJiraConnection,
  deleteJiraConnection,
  listJiraConnections,
  loadJiraSecret,
  retestJiraConnection,
} from './jira-connections';
import { keyring, manager, okJira, owner, startHarness, viewer } from './test-helpers';

const dc = (n: number, token = 'pat-secret-value') => ({
  name: `Corp Jira ${n}`,
  credentials: { kind: 'datacenter_pat' as const, baseUrl: `https://jira${n}.corp.example`, token },
});

describe('jira connections', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: ConnectionDeps;

  beforeAll(async () => {
    h = await startHarness();
    deps = { db: h.db, keyring, allowedPrivateHosts: [], testJira: okJira() };
  });
  afterAll(async () => h?.stop());

  it('stores the secret encrypted and never exposes it', async () => {
    const r = await createJiraConnection(deps, owner(), dc(1));
    expect(r).toMatchObject({
      ok: true,
      connection: { name: 'Corp Jira 1', status: 'ok', accountName: 'Pat' },
    });
    expect(JSON.stringify(r)).not.toContain('pat-secret-value');

    const [raw] = await h.rawDb.select().from(jiraConnections);
    expect(raw?.secret.startsWith('s1.')).toBe(true);
    expect(raw?.secret).not.toContain('pat-secret-value');

    const listed = await listJiraConnections(deps, 'org_a');
    expect(JSON.stringify(listed)).not.toContain('s1.');

    const secret = await loadJiraSecret(deps, 'org_a', r.ok ? r.connection.id : '');
    expect(secret?.credentials).toMatchObject({
      kind: 'datacenter_pat',
      token: 'pat-secret-value',
    });
  });

  it('writes an audit entry without secrets', async () => {
    const audits = await h.rawDb.select().from(auditLog);
    const created = audits.find((a) => a.action === 'jira_connection.created');
    expect(created?.metadata).toMatchObject({ deployment: 'datacenter', authType: 'pat' });
    expect(JSON.stringify(audits)).not.toContain('pat-secret-value');
  });

  it('does not save a connection that fails its test', async () => {
    const failing: ConnectionDeps = {
      ...deps,
      testJira: async () => ({
        ok: false,
        code: 'unauthorized',
        message: 'Jira rejected these credentials.',
      }),
    };
    const r = await createJiraConnection(failing, owner(), dc(2));
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
    expect((await listJiraConnections(deps, 'org_a')).map((c) => c.name)).not.toContain(
      'Corp Jira 2',
    );
  });

  it('rejects a duplicate base URL in the same org (after normalisation)', async () => {
    const dup = {
      ...dc(1),
      credentials: { ...dc(1).credentials, baseUrl: 'https://jira1.corp.example/' },
    };
    expect(await createJiraConnection(deps, owner(), dup)).toMatchObject({
      ok: false,
      code: 'duplicate',
    });
  });

  it('only lets owners/admins manage connections', async () => {
    for (const actor of [viewer(), manager()]) {
      await expect(createJiraConnection(deps, actor, dc(3))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("cannot see, retest, or delete another org's connection", async () => {
    const [a] = await listJiraConnections(deps, 'org_a');
    expect(await listJiraConnections(deps, 'org_b')).toEqual([]);
    expect(await loadJiraSecret(deps, 'org_b', a?.id ?? '')).toBeNull();
    expect(await retestJiraConnection(deps, owner('org_b'), a?.id ?? '')).toMatchObject({
      code: 'not_found',
    });
    expect(await deleteJiraConnection(deps, owner('org_b'), a?.id ?? '')).toMatchObject({
      code: 'not_found',
    });
  });

  it('records a failed retest on the connection', async () => {
    const [a] = await listJiraConnections(deps, 'org_a');
    const failing: ConnectionDeps = {
      ...deps,
      testJira: async () => ({
        ok: false,
        code: 'unauthorized',
        message: 'Jira rejected these credentials.',
      }),
    };
    const r = await retestJiraConnection(failing, owner(), a?.id ?? '');
    expect(r).toMatchObject({
      ok: true,
      connection: { status: 'error', lastError: 'unauthorized' },
    });
  });

  it('creates the org key once when two connections are saved concurrently for a new org', async () => {
    const results = await Promise.all([
      createJiraConnection(deps, owner('org_new'), dc(10)),
      createJiraConnection(deps, owner('org_new'), dc(11)),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const secrets = await Promise.all(
      (await listJiraConnections(deps, 'org_new')).map((c) =>
        loadJiraSecret(deps, 'org_new', c.id),
      ),
    );
    expect(secrets.every((s) => s !== null)).toBe(true);
  });

  it('deletes and audits', async () => {
    const [a] = await listJiraConnections(deps, 'org_a');
    expect(await deleteJiraConnection(deps, owner(), a?.id ?? '')).toEqual({ ok: true });
    expect(await listJiraConnections(deps, 'org_a')).toEqual([]);
  });
});
