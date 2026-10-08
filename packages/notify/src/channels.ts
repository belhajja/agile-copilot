import { randomUUID } from 'node:crypto';
import {
  type Actor,
  assertCanManage,
  type ConnectionDeps,
  getOrgDek,
  recordAudit,
} from '@agile/connections';
import { decryptSecret, encryptSecret } from '@agile/crypto';
import {
  type Db,
  deliveryChannels,
  isUniqueViolation,
  isUuid,
  skills,
  type Tx,
  withOrg,
} from '@agile/db';
import {
  type BlockedUrlReason,
  checkOutboundUrl,
  isAllowlistedHost,
  normalizeHost,
} from '@agile/net';
import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ChannelFailureCode } from './codes';
import { isSingleAddress, type SmtpSecret, verifySmtp } from './email';
import { type DeliveryCode, DeliveryError } from './errors';
import { type ChannelMessage, postWebhook } from './webhook';

/** What delivery needs from its host: the database, the keyring and the outbound policy. */
export interface NotifyDeps extends ConnectionDeps {
  /** Swap the SMTP check (tests). */
  verifySmtp?: typeof verifySmtp;
}

const name = z.string().trim().min(1).max(80);
const url = z.string().trim().min(1).max(2_000);
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV6 = /^\[?[0-9a-f:.]+\]?$/i;

/** What an admin enters. Secrets (URL, password) are encrypted at rest and never shown again. */
export const channelInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), name, url }).strict(),
  z.object({ kind: z.literal('teams'), name, url }).strict(),
  z
    .object({
      kind: z.literal('smtp'),
      name,
      host: z
        .string()
        .trim()
        .min(1)
        .max(253)
        .refine((h) => HOST.test(h) || IPV6.test(h)),
      port: z.coerce.number().int().min(1).max(65_535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: z.string().trim().max(320).optional(),
      password: z.string().max(1_000).optional(),
      // Exactly one plain address (no display name, list, CR/LF): what `sendEmail` accepts.
      // Defence in depth: zod's email pattern is already a subset of `isSingleAddress`, so no
      // address passes the first check and fails the second today; the refine pins the contract
      // with `sendEmail` should either side change.
      from: z.email().max(254).refine(isSingleAddress),
    })
    .strict(),
]);
export type ChannelInput = z.input<typeof channelInputSchema>;

type WebhookSecret = { url: string };
export type ChannelSecret = WebhookSecret | SmtpSecret;

export interface ChannelView {
  id: string;
  kind: 'smtp' | 'slack' | 'teams';
  name: string;
  /** Non-secret label: the webhook or SMTP host. */
  hint: string;
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

export type ChannelFailure = {
  ok: false;
  code: ChannelFailureCode;
  /** Why a URL or host was refused (translated by the UI). */
  reason?: BlockedUrlReason;
  host?: string;
  status?: number;
};

const secretContext = (id: string) => `delivery_channel:${id}`;

async function seal(tx: Tx, deps: NotifyDeps, orgId: string, id: string, secret: ChannelSecret) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return encryptSecret(dek, secretContext(id), JSON.stringify(secret));
}

const webhookSecretSchema = z.object({ url: z.string().min(1) }).strict();
const smtpSecretSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    security: z.enum(['tls', 'starttls', 'none']),
    username: z.string().optional(),
    password: z.string().optional(),
    from: z.string().min(1),
  })
  .strict();

/**
 * Decrypts a channel's secret and checks its shape against the row's kind. A row that cannot be
 * decrypted or parsed is reported as `invalid_channel` (a code), never as a crypto or type error.
 */
async function unseal(
  tx: Tx,
  deps: NotifyDeps,
  orgId: string,
  row: { id: string; kind: ChannelView['kind']; secret: string },
): Promise<ChannelSecret> {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  let value: unknown;
  try {
    value = JSON.parse(decryptSecret(dek, secretContext(row.id), row.secret));
  } catch {
    throw new DeliveryError('invalid_channel');
  }
  const parsed = (row.kind === 'smtp' ? smtpSecretSchema : webhookSecretSchema).safeParse(value);
  if (!parsed.success) throw new DeliveryError('invalid_channel');
  return parsed.data;
}

/**
 * The outbound rule for a user-supplied host: the SSRF policy, and plaintext (http webhooks,
 * SMTP without TLS) only towards hosts the operator allowlisted as internal.
 */
async function checkTarget(
  deps: NotifyDeps,
  target: string,
  plaintext: boolean,
): Promise<{ ok: true; host: string } | ChannelFailure> {
  const check = await checkOutboundUrl(target, deps);
  if (!check.ok && check.code === 'insecure_transport') {
    return { ok: false, code: 'insecure_transport', host: check.host };
  }
  if (!check.ok) {
    return { ok: false, code: 'blocked_url', reason: check.code, host: check.host };
  }
  const host = normalizeHost(check.url.hostname);
  if (plaintext && !isAllowlistedHost(host, deps.allowedPrivateHosts)) {
    return { ok: false, code: 'insecure_transport', host };
  }
  return { ok: true, host };
}

/**
 * The name, and for SMTP the one-server rule, checked before the outbound test: a duplicate never
 * posts a test message or logs in. The unique indexes still decide on insert (races).
 */
async function isTaken(deps: NotifyDeps, actor: Actor, kind: ChannelView['kind'], name: string) {
  const rows = await withOrg(deps.db, actor.orgId, (tx) =>
    tx
      .select({ id: deliveryChannels.id })
      .from(deliveryChannels)
      .where(
        kind === 'smtp'
          ? or(eq(deliveryChannels.name, name), eq(deliveryChannels.kind, 'smtp'))
          : eq(deliveryChannels.name, name),
      )
      .limit(1),
  );
  return rows.length > 0;
}

const failureOf = (e: unknown): ChannelFailure => {
  if (e instanceof DeliveryError) {
    return e.status === undefined
      ? { ok: false, code: e.code }
      : { ok: false, code: e.code, status: e.status };
  }
  throw e;
};

/**
 * Adds a delivery channel (workspace owners/admins). It is tested before it is saved: a webhook
 * receives `testMessage`, an SMTP server is connected to (and logged in to) without sending mail.
 */
export async function createDeliveryChannel(
  deps: NotifyDeps,
  actor: Actor,
  raw: unknown,
  opts: { testMessage: ChannelMessage },
): Promise<{ ok: true; channel: ChannelView } | ChannelFailure> {
  assertCanManage(actor);
  const parsed = channelInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'invalid_input' };
  const input = parsed.data;

  let secret: ChannelSecret;
  let hint: string;
  if (input.kind === 'smtp') {
    const host = normalizeHost(input.host);
    const target = await checkTarget(
      deps,
      `https://${host.includes(':') ? `[${host}]` : host}/`,
      input.security === 'none',
    );
    if (!target.ok) return target;
    if (await isTaken(deps, actor, input.kind, input.name)) return { ok: false, code: 'duplicate' };
    secret = {
      host,
      port: input.port,
      security: input.security,
      username: input.username || undefined,
      password: input.password || undefined,
      from: input.from,
    };
    hint = `${host}:${input.port}`;
    try {
      await (deps.verifySmtp ?? verifySmtp)(secret, { outbound: deps });
    } catch (e) {
      return failureOf(e);
    }
  } else {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      return { ok: false, code: 'invalid_input' };
    }
    const target = await checkTarget(deps, input.url, parsedUrl.protocol === 'http:');
    if (!target.ok) return target;
    if (await isTaken(deps, actor, input.kind, input.name)) return { ok: false, code: 'duplicate' };
    secret = { url: parsedUrl.toString() };
    hint = target.host;
    try {
      await postWebhook(input.kind, secret.url, opts.testMessage, { outbound: deps });
    } catch (e) {
      return failureOf(e);
    }
  }

  const id = randomUUID();
  try {
    const row = await withOrg(deps.db, actor.orgId, async (tx) => {
      const [inserted] = await tx
        .insert(deliveryChannels)
        .values({
          id,
          orgId: actor.orgId,
          kind: input.kind,
          name: input.name,
          hint,
          secret: await seal(tx, deps, actor.orgId, id, secret),
          lastCheckedAt: new Date(),
          createdBy: actor.userId,
        })
        .returning();
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'delivery_channel.created',
        targetType: 'delivery_channel',
        targetId: id,
        metadata: { kind: input.kind, hint },
      });
      return inserted;
    });
    if (!row) throw new Error('channel insert returned nothing');
    return { ok: true, channel: toView(row) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: 'duplicate' };
    throw e;
  }
}

const toView = (r: typeof deliveryChannels.$inferSelect): ChannelView => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  hint: r.hint,
  lastError: r.lastError,
  lastCheckedAt: r.lastCheckedAt,
  createdAt: r.createdAt,
});

/** The workspace's channels (no secrets). Any member may list them, to pick one for a skill. */
export async function listDeliveryChannels(db: Db, orgId: string): Promise<ChannelView[]> {
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .select()
      .from(deliveryChannels)
      .orderBy(asc(deliveryChannels.kind), asc(deliveryChannels.name)),
  );
  return rows.map(toView);
}

/** Deletes a channel (owners/admins). Skills that used it then fail to deliver with a code. */
export async function deleteDeliveryChannel(
  deps: NotifyDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | ChannelFailure> {
  assertCanManage(actor);
  if (!isUuid(id)) return { ok: false, code: 'not_found' };
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const [deleted] = await tx
      .delete(deliveryChannels)
      .where(eq(deliveryChannels.id, id))
      .returning({ kind: deliveryChannels.kind, hint: deliveryChannels.hint });
    if (!deleted) return { ok: false, code: 'not_found' } as const;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'delivery_channel.deleted',
      targetType: 'delivery_channel',
      targetId: id,
      metadata: { kind: deleted.kind, hint: deleted.hint },
    });
    return { ok: true } as const;
  });
}

/**
 * A channel with its decrypted secret, for delivery only (never returned to a browser). Throws
 * `DeliveryError('invalid_channel')` when the stored secret cannot be read.
 */
export async function loadChannel(
  deps: NotifyDeps,
  orgId: string,
  where: { id: string } | { kind: 'smtp' },
): Promise<{ id: string; kind: ChannelView['kind']; secret: ChannelSecret } | null> {
  if ('id' in where && !isUuid(where.id)) return null;
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(deliveryChannels)
      .where('id' in where ? eq(deliveryChannels.id, where.id) : eq(deliveryChannels.kind, 'smtp'))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      secret: await unseal(tx, deps, orgId, row),
    };
  });
}

/** Records the outcome of the last delivery on a channel (a code, never a message). */
export async function markChannel(
  db: Db,
  orgId: string,
  id: string,
  error: DeliveryCode | null,
): Promise<void> {
  if (!isUuid(id)) return;
  await withOrg(db, orgId, (tx) =>
    tx
      .update(deliveryChannels)
      .set({ lastError: error, lastCheckedAt: new Date() })
      .where(eq(deliveryChannels.id, id)),
  );
}

/** A skill posting to a channel (no document text): what the Delivery page shows per channel. */
export interface ChannelUser {
  id: string;
  name: string;
  ownerUserId: string;
}

/**
 * The skills that post to each channel, keyed by channel id (owners/admins: they manage channels).
 * Only Slack/Teams outputs count: a skill switched to another output may keep a stale channel id.
 */
export async function listChannelUsage(
  db: Db,
  actor: Actor,
): Promise<Record<string, ChannelUser[]>> {
  assertCanManage(actor);
  const rows = await withOrg(db, actor.orgId, (tx) =>
    tx
      .select({
        channelId: skills.channelId,
        id: skills.id,
        name: skills.name,
        ownerUserId: skills.ownerUserId,
      })
      .from(skills)
      .where(and(isNotNull(skills.channelId), inArray(skills.output, ['slack', 'teams'])))
      .orderBy(asc(skills.name), asc(skills.id)),
  );
  const usage: Record<string, ChannelUser[]> = {};
  for (const { channelId, ...skill } of rows) {
    if (!channelId) continue;
    const list = usage[channelId] ?? [];
    list.push(skill);
    usage[channelId] = list;
  }
  return usage;
}
