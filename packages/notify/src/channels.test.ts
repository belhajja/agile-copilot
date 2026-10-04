import { type Actor, ForbiddenError, getOrgDek } from '@agile/connections';
import { encryptSecret, parseKeyring } from '@agile/crypto';
import { auditLog, createDb, deliveryChannels, skills, withOrg } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryChannel,
  deleteDeliveryChannel,
  listChannelUsage,
  listDeliveryChannels,
  loadChannel,
  markChannel,
  type NotifyDeps,
} from './channels';
import { DeliveryError } from './errors';
import { DIGEST_LABELS } from './labels';
import { type MockSmtp, type MockWebhook, startMockSmtp, startMockWebhook } from './testing';

const owner: Actor = { orgId: 'org_a', userId: 'user_owner', roles: ['owner'] };
const viewer: Actor = { orgId: 'org_a', userId: 'user_m', roles: ['viewer'] };
const manager: Actor = { orgId: 'org_a', userId: 'user_mgr', roles: ['manager'] };
const other: Actor = { orgId: 'org_b', userId: 'user_b', roles: ['owner'] };
const testMessage = { title: DIGEST_LABELS.en.testTitle, text: DIGEST_LABELS.en.testText };

describe('delivery channels', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;
  let hook: MockWebhook;
  let smtp: MockSmtp;
  let deps: NotifyDeps;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    hook = await startMockWebhook();
    smtp = await startMockSmtp({ auth: { user: 'bot', pass: 'smtp-password-123' } });
    deps = {
      db: app.db,
      keyring: parseKeyring(`v1:${Buffer.alloc(32, 5).toString('base64')}`),
      allowedPrivateHosts: ['127.0.0.1'],
    };
  });
  afterAll(async () => {
    await hook?.close();
    await smtp?.close();
    await app?.close();
    await raw?.close();
    await tdb?.stop();
  });

  const slackUrl = () => `${hook.url}/services/T000/B000/secret-token-xyz`;

  it('tests a Slack webhook with a message, then stores its URL encrypted', async () => {
    const r = await createDeliveryChannel(
      deps,
      owner,
      { kind: 'slack', name: 'Delivery team', url: slackUrl() },
      { testMessage },
    );
    expect(r).toMatchObject({ ok: true, channel: { kind: 'slack', hint: '127.0.0.1' } });
    expect(hook.posts.at(-1)?.body).toMatchObject({ text: 'Agile Copilot is connected' });
    const rows = await raw.db.select().from(deliveryChannels);
    expect(JSON.stringify(rows)).not.toContain('secret-token-xyz');
    const views = await listDeliveryChannels(app.db, 'org_a');
    expect(JSON.stringify(views)).not.toContain('secret-token-xyz');
    expect(views.map((v) => v.name)).toEqual(['Delivery team']);
    if (!r.ok) throw new Error('unreachable');
    expect(await loadChannel(deps, 'org_a', { id: r.channel.id })).toEqual({
      id: r.channel.id,
      kind: 'slack',
      secret: { url: slackUrl() },
    });
    // Another workspace cannot load it, and a malformed id is simply not found.
    expect(await loadChannel(deps, 'org_b', { id: r.channel.id })).toBeNull();
    expect(await loadChannel(deps, 'org_a', { id: 'not-a-uuid' })).toBeNull();
    // A second channel with the same name is refused before anything is posted.
    const posts = hook.posts.length;
    expect(
      await createDeliveryChannel(
        deps,
        owner,
        { kind: 'teams', name: 'Delivery team', url: `${hook.url}/teams` },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'duplicate' });
    expect(hook.posts.length).toBe(posts);
  });

  it('checks an SMTP server (login included) without sending, and keeps one per workspace', async () => {
    const input = {
      kind: 'smtp',
      name: 'Mail',
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      username: 'bot',
      password: 'smtp-password-123',
      from: 'copilot@example.com',
    };
    expect(
      await createDeliveryChannel(
        deps,
        owner,
        { ...input, name: 'Bad', password: 'x' },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'auth_failed' });
    const r = await createDeliveryChannel(deps, owner, input, { testMessage });
    expect(r).toMatchObject({
      ok: true,
      channel: { kind: 'smtp', hint: `127.0.0.1:${smtp.port}` },
    });
    expect(smtp.mails).toEqual([]);
    expect(JSON.stringify(await raw.db.select().from(deliveryChannels))).not.toContain(
      'smtp-password-123',
    );
    expect(await loadChannel(deps, 'org_a', { kind: 'smtp' })).toMatchObject({
      kind: 'smtp',
      secret: { host: '127.0.0.1', password: 'smtp-password-123', from: 'copilot@example.com' },
    });
    // One SMTP server per workspace: a second one is refused before connecting or logging in.
    const check = vi.fn(async () => undefined);
    expect(
      await createDeliveryChannel(
        { ...deps, verifySmtp: check },
        owner,
        { ...input, name: 'Second mail' },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'duplicate' });
    expect(check).not.toHaveBeenCalled();
  });

  it('accepts exactly one plain sender address for SMTP', async () => {
    const before = (await listDeliveryChannels(app.db, 'org_a')).length;
    for (const from of [
      'copilot@example.com\r\nBcc: spy@evil.example',
      'copilot@example.com\nBcc: spy@evil.example',
      'copilot@example.com, spy@evil.example',
      'copilot@example.com;spy@evil.example',
      'Copilot <copilot@example.com>',
      '"copilot,x"@example.com',
    ]) {
      expect(
        await createDeliveryChannel(
          deps,
          owner,
          {
            kind: 'smtp',
            name: 'Other mail',
            host: '127.0.0.1',
            port: smtp.port,
            security: 'none',
            from,
          },
          { testMessage },
        ),
        from,
      ).toEqual({ ok: false, code: 'invalid_input' });
    }
    expect((await listDeliveryChannels(app.db, 'org_a')).length).toBe(before);
  });

  it('refuses unsafe targets before saving anything', async () => {
    const before = (await listDeliveryChannels(app.db, 'org_a')).length;
    const strict = { ...deps, allowedPrivateHosts: [] };
    expect(
      await createDeliveryChannel(
        strict,
        owner,
        { kind: 'slack', name: 'x', url: slackUrl() },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'blocked_url', reason: 'private_address', host: '127.0.0.1' });
    // Plain http to a public host: the URL would travel unencrypted.
    expect(
      await createDeliveryChannel(
        { ...strict, resolve: async () => ['93.184.216.34'] },
        owner,
        { kind: 'teams', name: 'x', url: 'http://hooks.example.com/workflow' },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'insecure_transport', host: 'hooks.example.com' });
    expect(
      await createDeliveryChannel(
        { ...strict, resolve: async () => ['93.184.216.34'] },
        owner,
        {
          kind: 'smtp',
          name: 'x',
          host: 'smtp.example.com',
          port: 25,
          security: 'none',
          from: 'a@example.com',
        },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'insecure_transport', host: 'smtp.example.com' });
    expect(
      await createDeliveryChannel(
        deps,
        owner,
        { kind: 'slack', name: 'x', url: `${hook.url}/fail` },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'rejected', status: 500 });
    expect(
      await createDeliveryChannel(
        deps,
        owner,
        { kind: 'slack', name: 'x', url: 'not a url' },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'invalid_input' });
    expect(
      await createDeliveryChannel(
        deps,
        owner,
        { kind: 'slack', name: 'x', url: slackUrl(), extra: 1 },
        { testMessage },
      ),
    ).toEqual({ ok: false, code: 'invalid_input' });
    expect((await listDeliveryChannels(app.db, 'org_a')).length).toBe(before);
  });

  it('records the last delivery outcome as a code', async () => {
    const slack = (await listDeliveryChannels(app.db, 'org_a')).find((c) => c.kind === 'slack');
    if (!slack) throw new Error('no slack channel');
    await markChannel(app.db, 'org_a', slack.id, 'rejected');
    expect(
      (await listDeliveryChannels(app.db, 'org_a')).find((c) => c.id === slack.id),
    ).toMatchObject({ lastError: 'rejected' });
    await markChannel(app.db, 'org_a', slack.id, null);
    expect(
      (await listDeliveryChannels(app.db, 'org_a')).find((c) => c.id === slack.id),
    ).toMatchObject({ lastError: null });
    // A malformed id is ignored (no query error).
    await expect(markChannel(app.db, 'org_a', 'not-a-uuid', 'timeout')).resolves.toBeUndefined();
  });

  it('reports a corrupt stored secret as a code', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    await withOrg(app.db, 'org_a', async (tx) => {
      const dek = await getOrgDek(tx, deps.keyring, 'org_a');
      const row = (n: number, kind: 'slack' | 'teams', secret: string) => ({
        id: id(n),
        orgId: 'org_a',
        kind,
        name: `Corrupt ${n}`,
        hint: 'x',
        secret,
        createdBy: 'user_owner',
      });
      await tx.insert(deliveryChannels).values([
        // Not decryptable.
        row(1, 'slack', 'garbage'),
        // Decryptable, not JSON.
        row(2, 'slack', encryptSecret(dek, `delivery_channel:${id(2)}`, 'not json')),
        // JSON of the wrong shape for its kind (an SMTP secret on a Teams row).
        row(
          3,
          'teams',
          encryptSecret(
            dek,
            `delivery_channel:${id(3)}`,
            JSON.stringify({ host: 'h', port: 25, security: 'tls', from: 'a@example.com' }),
          ),
        ),
      ]);
    });
    for (const n of [1, 2, 3]) {
      const error = await loadChannel(deps, 'org_a', { id: id(n) }).catch((e: unknown) => e);
      expect(error, `row ${n}`).toBeInstanceOf(DeliveryError);
      expect((error as DeliveryError).code).toBe('invalid_channel');
    }
    await withOrg(app.db, 'org_a', (tx) =>
      tx.delete(deliveryChannels).where(like(deliveryChannels.name, 'Corrupt %')),
    );
    expect(
      await raw.db
        .select()
        .from(deliveryChannels)
        .where(eq(deliveryChannels.id, id(1))),
    ).toEqual([]);
  });

  it('lists the skills that post to each channel, for owners and admins only', async () => {
    const slack = (await listDeliveryChannels(app.db, 'org_a')).find((c) => c.kind === 'slack');
    if (!slack) throw new Error('no slack channel');
    const skill = (name: string, output: 'slack' | 'chat', ownerUserId = 'user_m') => ({
      orgId: 'org_a',
      ownerUserId,
      name,
      description: 'd',
      trigger: 'schedule' as const,
      output,
      channelId: slack.id,
    });
    const inserted = await withOrg(app.db, 'org_a', (tx) =>
      tx
        .insert(skills)
        .values([
          skill('Weekly digest', 'slack', 'user_owner'),
          skill('Blockers', 'slack'),
          // Output changed to chat since: the stale channel id does not count.
          skill('Old', 'chat'),
        ])
        .returning({ id: skills.id, name: skills.name })
        .then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name))),
    );
    const [blockers, , weekly] = inserted;
    expect(await listChannelUsage(app.db, owner)).toEqual({
      [slack.id]: [
        { id: blockers?.id, name: 'Blockers', ownerUserId: 'user_m' },
        { id: weekly?.id, name: 'Weekly digest', ownerUserId: 'user_owner' },
      ],
    });
    expect(await listChannelUsage(app.db, other)).toEqual({});
    for (const actor of [viewer, manager]) {
      await expect(listChannelUsage(app.db, actor)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await withOrg(app.db, 'org_a', (tx) => tx.delete(skills));
  });

  it('is managed by workspace owners and admins only, within their workspace', async () => {
    for (const actor of [viewer, manager]) {
      await expect(
        createDeliveryChannel(
          deps,
          actor,
          { kind: 'slack', name: 'm', url: slackUrl() },
          { testMessage },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    const [first] = await listDeliveryChannels(app.db, 'org_a');
    if (!first) throw new Error('no channel');
    for (const actor of [viewer, manager]) {
      await expect(deleteDeliveryChannel(deps, actor, first.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await deleteDeliveryChannel(deps, other, first.id)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await deleteDeliveryChannel(deps, owner, 'not-a-uuid')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await deleteDeliveryChannel(deps, owner, first.id)).toEqual({ ok: true });
    const audit = await raw.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(like(auditLog.action, 'delivery_channel.%'))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    expect(audit.map((a) => a.action)).toEqual([
      'delivery_channel.created',
      'delivery_channel.created',
      'delivery_channel.deleted',
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/secret-token-xyz|smtp-password-123/);
  });
});
