import { parseRoles } from '@agile/auth';
import {
  account,
  agentConversations,
  agentMessages,
  agentUsage,
  auditLog,
  type Db,
  invitation,
  jiraConnections,
  member,
  organization,
  personalDataExports,
  recordAudit,
  rows,
  session,
  skillRuns,
  skills,
  skillVersions,
  type Tx,
  user,
  verification,
  withOrg,
} from '@agile/db';
import { and, asc, eq, gt, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** Rows read per query while exporting: a long history is never loaded at once (L14). */
export const EXPORT_PAGE_SIZE = 200;

/**
 * Tables kept, pseudonymised, when an account is deleted: the opaque user id stays, nothing that
 * identifies the person (their user row, e-mail and name are deleted). Usage keeps workspace spend
 * totals right; the audit log is the workspace's legal record.
 */
const KEPT_ON_DELETION = new Set(['audit_log', 'agent_usage']);
/** Exported by dedicated sections below, not by the generic one. */
const EXPORTED_EXPLICITLY = new Set([
  'agent_usage',
  'agent_conversations',
  'agent_messages',
  'skills',
  'skill_runs',
]);
/** Never exported, whatever the table: credentials, tokens and key material. */
const SECRET_COLUMNS = new Set([
  'secret',
  'token_hash',
  'wrapped_dek',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
]);

interface PersonalTable {
  table: string;
  column: string;
}

type Query = Db | Tx;

/**
 * Every tenant table with a column naming the person who owns a row (`org_id` plus `user_id` or
 * `owner_user_id`), discovered at run time so tables added later are covered.
 */
async function personalTables(q: Query): Promise<PersonalTable[]> {
  return rows<PersonalTable>(
    q,
    sql`
    select c.table_name as "table", c.column_name as "column"
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.column_name in ('user_id', 'owner_user_id')
      and exists (select 1 from information_schema.columns o
        where o.table_schema = 'public' and o.table_name = c.table_name and o.column_name = 'org_id')
    order by c.table_name, c.column_name
  `,
  );
}

/**
 * The table's person column, compared as text: user ids are text, and a column of another type
 * (a later table's choice) must neither break nor escape the export and the erasure.
 */
const personCol = (t: PersonalTable) => sql`${sql.identifier(t.column)}::text`;

/** Scopes the rest of this transaction to one workspace (RLS), like `withOrg` does. */
const enterOrg = (tx: Tx, orgId: string) =>
  tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);

interface Workspace {
  orgId: string;
  workspace: string;
}

/**
 * Every workspace the person has rows in, member or not (M2: a former member's conversations,
 * skills, runs, usage, tokens or audit entries stay until erased). RLS shows the app one workspace
 * at a time, so this asks `user_org_ids` (SECURITY DEFINER, P5-R37/R38): under each workspace's
 * RLS context in turn, one indexed probe per personal table; workspace ids only.
 */
async function personOrgIds(q: Query, userId: string): Promise<string[]> {
  const ids = await rows<{ id: string }>(q, sql`select id from user_org_ids(${userId}) as id`);
  return ids.map((r) => r.id);
}

/** Of `ids`, the workspaces that still exist and the person is no longer a member of. */
async function formerWorkspaces(
  q: Query,
  ids: readonly string[],
  current: ReadonlySet<string>,
): Promise<Workspace[]> {
  const former = ids.filter((id) => !current.has(id));
  if (former.length === 0) return [];
  return q
    .select({ orgId: organization.id, workspace: organization.name })
    .from(organization)
    .where(inArray(organization.id, former))
    .orderBy(asc(organization.name), asc(organization.id));
}

/** A key column for keyset paging: its name and its SQL type (from the catalog). */
interface KeyColumn {
  name: string;
  type: string;
}
/** Physical row order, for a table without a primary key. */
const CTID_KEY: KeyColumn[] = [{ name: 'ctid', type: 'tid' }];
/** Catalog type names only (`format_type`), checked before they are written into a query. */
const SAFE_TYPE = /^[a-z][a-z0-9 _(),]*$/;

/**
 * The table's primary key columns, in key order, to page by (stable across transactions);
 * `ctid` when there is none or a type is unexpected.
 */
async function pagingKeyOf(q: Query, table: string): Promise<KeyColumn[]> {
  const key = await rows<KeyColumn>(
    q,
    sql`
    select a.attname as "name", format_type(a.atttypid, a.atttypmod) as "type"
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where n.nspname = 'public' and c.relname = ${table} and i.indisprimary
    order by array_position(i.indkey::int2[], a.attnum)
  `,
  );
  if (key.length === 0 || !key.every((r) => SAFE_TYPE.test(r.type))) return CTID_KEY;
  return key;
}

const withoutSecrets = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_COLUMNS.has(k)));

const json = (v: unknown) => JSON.stringify(v);
/** An object's JSON without its closing brace, so more (streamed) members can follow. */
const open = (v: Record<string, unknown>) => json(v).slice(0, -1);

/** Keyset pagination: fetches pages until a short one. */
async function* paged<T, K>(
  fetch: (after: K | undefined) => Promise<T[]>,
  keyOf: (row: T) => K,
): AsyncGenerator<T> {
  let after: K | undefined;
  for (;;) {
    const page = await fetch(after);
    yield* page;
    const last = page.at(-1);
    if (page.length < EXPORT_PAGE_SIZE || last === undefined) return;
    after = keyOf(last);
  }
}

/** A JSON array produced item by item; `each` turns one item into its JSON text. */
async function* jsonArray<T>(
  items: AsyncIterable<T> | Iterable<T>,
  each: (item: T) => AsyncGenerator<string> | string = json,
): AsyncGenerator<string> {
  yield '[';
  let first = true;
  for await (const item of items) {
    if (!first) yield ',';
    first = false;
    const out = each(item);
    if (typeof out === 'string') yield out;
    else yield* out;
  }
  yield ']';
}

const afterId = (column: AnyPgColumn, after: string | undefined) =>
  after === undefined ? undefined : gt(column, after);

/** One workspace's part of the export, every section read page by page under its RLS context. */
async function* workspaceSection(
  db: Db,
  userId: string,
  ws: Workspace & { role: string[]; joinedAt: Date | null; member: boolean },
  tables: PersonalTable[],
  keys: ReadonlyMap<string, KeyColumn[]>,
): AsyncGenerator<string> {
  const inOrg = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(db, ws.orgId, fn);

  yield `{"workspace":${json(ws)},"conversations":`;
  const conversations = paged(
    (after: string | undefined) =>
      inOrg((tx) =>
        tx
          .select({
            id: agentConversations.id,
            title: agentConversations.title,
            groupId: agentConversations.groupId,
            llmConnectionId: agentConversations.llmConnectionId,
            archivedAt: agentConversations.archivedAt,
            createdAt: agentConversations.createdAt,
            updatedAt: agentConversations.updatedAt,
          })
          .from(agentConversations)
          .where(and(eq(agentConversations.userId, userId), afterId(agentConversations.id, after)))
          .orderBy(asc(agentConversations.id))
          .limit(EXPORT_PAGE_SIZE),
      ),
    (c) => c.id,
  );
  yield* jsonArray(conversations, async function* (c) {
    yield `${open(c)},"messages":`;
    yield* jsonArray(
      paged(
        (after: number | undefined) =>
          inOrg((tx) =>
            tx
              .select({
                seq: agentMessages.seq,
                role: agentMessages.role,
                parts: agentMessages.parts,
                at: agentMessages.createdAt,
              })
              .from(agentMessages)
              .where(
                and(
                  eq(agentMessages.conversationId, c.id),
                  after === undefined ? undefined : gt(agentMessages.seq, after),
                ),
              )
              .orderBy(asc(agentMessages.seq))
              .limit(EXPORT_PAGE_SIZE),
          ),
        (m) => m.seq,
      ),
      ({ seq: _seq, ...m }) => json(m),
    );
    yield '}';
  });

  // Their skills: the current text and the reports of their runs.
  yield ',"skills":';
  const owned = paged(
    (after: string | undefined) =>
      inOrg((tx) =>
        tx
          .select({
            id: skills.id,
            name: skills.name,
            description: skills.description,
            trigger: skills.trigger,
            output: skills.output,
            visibility: skills.visibility,
            enabled: skills.enabled,
            createdAt: skills.createdAt,
            document: skillVersions.document,
          })
          .from(skills)
          .leftJoin(
            skillVersions,
            and(
              eq(skillVersions.skillId, skills.id),
              eq(skillVersions.version, skills.currentVersion),
            ),
          )
          .where(and(eq(skills.ownerUserId, userId), afterId(skills.id, after)))
          .orderBy(asc(skills.id))
          .limit(EXPORT_PAGE_SIZE),
      ),
    (k) => k.id,
  );
  const runsWhere = (where: SQL | undefined) =>
    paged(
      (after: string | undefined) =>
        inOrg((tx) =>
          tx
            .select({
              id: skillRuns.id,
              trigger: skillRuns.trigger,
              status: skillRuns.status,
              resultCode: skillRuns.resultCode,
              output: skillRuns.output,
              scheduledFor: skillRuns.scheduledFor,
              createdAt: skillRuns.createdAt,
              finishedAt: skillRuns.finishedAt,
            })
            .from(skillRuns)
            .where(and(where, afterId(skillRuns.id, after)))
            .orderBy(asc(skillRuns.id))
            .limit(EXPORT_PAGE_SIZE),
        ),
      (r) => r.id,
    );
  yield* jsonArray(owned, async function* ({ id, ...k }) {
    yield `${open(k)},"runs":`;
    yield* jsonArray(runsWhere(eq(skillRuns.skillId, id)), ({ id: _id, ...r }) => json(r));
    yield '}';
  });
  // Runs outlive a deleted skill (P4-R31): they are still the person's reports.
  yield ',"runsOfDeletedSkills":';
  yield* jsonArray(
    runsWhere(and(eq(skillRuns.ownerUserId, userId), isNull(skillRuns.skillId))),
    ({ id: _id, ...r }) => json(r),
  );

  yield ',"usage":';
  yield* jsonArray(
    paged(
      (after: string | undefined) =>
        inOrg((tx) =>
          tx
            .select({
              id: agentUsage.id,
              provider: agentUsage.provider,
              model: agentUsage.model,
              inputTokens: agentUsage.inputTokens,
              outputTokens: agentUsage.outputTokens,
              cachedInputTokens: agentUsage.cachedInputTokens,
              costMicros: agentUsage.costMicros,
              createdAt: agentUsage.createdAt,
            })
            .from(agentUsage)
            .where(and(eq(agentUsage.userId, userId), afterId(agentUsage.id, after)))
            .orderBy(asc(agentUsage.id))
            .limit(EXPORT_PAGE_SIZE),
        ),
      (u) => u.id,
    ),
    ({ id: _id, ...u }) => json(u),
  );

  yield ',"actionsInAuditLog":';
  yield* jsonArray(
    paged(
      (after: string | undefined) =>
        inOrg((tx) =>
          tx
            .select({
              id: auditLog.id,
              action: auditLog.action,
              targetType: auditLog.targetType,
              targetId: auditLog.targetId,
              metadata: auditLog.metadata,
              createdAt: auditLog.createdAt,
            })
            .from(auditLog)
            .where(and(eq(auditLog.actorUserId, userId), afterId(auditLog.id, after)))
            .orderBy(asc(auditLog.id))
            .limit(EXPORT_PAGE_SIZE),
        ),
      (a) => a.id,
    ),
    ({ id: _id, ...a }) => json(a),
  );

  // Jira connections they made: the Jira account the connection signed in as is theirs (its
  // display name and id); the connection itself belongs to the workspace. Never the secret.
  yield ',"jiraConnections":';
  yield* jsonArray(
    paged(
      (after: string | undefined) =>
        inOrg((tx) =>
          tx
            .select({
              id: jiraConnections.id,
              name: jiraConnections.name,
              baseUrl: jiraConnections.baseUrl,
              accountId: jiraConnections.accountId,
              accountName: jiraConnections.accountName,
              createdAt: jiraConnections.createdAt,
            })
            .from(jiraConnections)
            .where(and(eq(jiraConnections.createdBy, userId), afterId(jiraConnections.id, after)))
            .orderBy(asc(jiraConnections.id))
            .limit(EXPORT_PAGE_SIZE),
        ),
      (c) => c.id,
    ),
    ({ id: _id, ...c }) => json(c),
  );

  // Any other tenant table naming the person (later tables included), secret columns dropped.
  yield ',"other":{';
  let firstTable = true;
  for (const t of tables) {
    if (EXPORTED_EXPLICITLY.has(t.table)) continue;
    const key = keys.get(t.table) ?? CTID_KEY;
    const cols = sql.join(
      key.map((k) => sql`r.${sql.identifier(k.name)}`),
      sql`, `,
    );
    const found = paged(
      (after: string[] | undefined) =>
        inOrg((tx) =>
          rows<{ key: string[]; row: Record<string, unknown> }>(
            tx,
            sql`
              select jsonb_build_array(${sql.join(
                key.map((k) => sql`r.${sql.identifier(k.name)}::text`),
                sql`, `,
              )}) as "key", to_jsonb(r) as "row"
              from ${sql.identifier(t.table)} r
              where ${personCol(t)} = ${userId}
                ${
                  after === undefined
                    ? sql``
                    : sql`and (${cols}) > (${sql.join(
                        key.map((k, i) => sql`${after[i] ?? null}::${sql.raw(k.type)}`),
                        sql`, `,
                      )})`
                }
              order by ${cols}
              limit ${EXPORT_PAGE_SIZE}
            `,
          ),
        ),
      (r) => r.key,
    );
    let first = true;
    for await (const r of found) {
      if (first) yield `${firstTable ? '' : ','}${json(t.table)}:[`;
      else yield ',';
      first = false;
      firstTable = false;
      yield json(withoutSecrets(r.row));
    }
    if (!first) yield ']';
  }
  yield '}}';
}

/**
 * Everything the service holds about one person, as a JSON document produced piece by piece (a
 * large history never sits in memory). Covers every workspace they belong to or still have rows
 * in; each workspace's part is read under that workspace's RLS context, and only rows that name
 * the person are included, never their colleagues' data. Credentials, tokens and key material
 * (`SECRET_COLUMNS`, session tokens, OAuth tokens, password hashes) never leave.
 */
export async function* exportUserData(db: Db, userId: string): AsyncGenerator<string> {
  const [profile] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .where(eq(user.id, userId));
  if (!profile) return;
  // Sign-in methods without their tokens or password hash.
  const signInMethods = await db
    .select({
      providerId: account.providerId,
      accountId: account.accountId,
      scope: account.scope,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(asc(account.createdAt));
  const sessions = await db
    .select({
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(asc(session.createdAt));
  // Invitations they sent (without the invitee's address: someone else's data) and received.
  const sent = await db
    .select({
      workspace: organization.name,
      role: invitation.role,
      status: invitation.status,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.inviterId, userId))
    .orderBy(asc(invitation.createdAt));
  const received = await db
    .select({
      workspace: organization.name,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(sql`lower(${invitation.email}) = lower(${profile.email})`)
    .orderBy(asc(invitation.createdAt));
  const memberships = await db
    .select({
      orgId: member.organizationId,
      workspace: organization.name,
      role: member.role,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt), asc(member.organizationId));
  const tables = await personalTables(db);
  const keys = new Map<string, KeyColumn[]>();
  for (const t of tables) {
    if (!EXPORTED_EXPLICITLY.has(t.table)) keys.set(t.table, await pagingKeyOf(db, t.table));
  }
  const former = await formerWorkspaces(
    db,
    await personOrgIds(db, userId),
    new Set(memberships.map((m) => m.orgId)),
  );
  const workspaces = [
    ...memberships.map((m) => ({ ...m, role: parseRoles(m.role), member: true })),
    ...former.map((f) => ({ ...f, role: [], joinedAt: null, member: false })),
  ];

  yield `{"exportedAt":${json(new Date())},"user":${json(profile)},"signInMethods":${json(signInMethods)},"sessions":${json(sessions)},"invitations":${json({ sent, received })},"workspaces":`;
  yield* jsonArray(workspaces, (ws) => workspaceSection(db, userId, ws, tables, keys));
  yield '}';
}

export type DeleteAccountResult =
  | { ok: true; workspaces: number }
  | { ok: false; code: 'sole_owner'; workspaces: string[] }
  | { ok: false; code: 'not_found' | 'rate_limited' };

/** Account-deletion attempts one person may make per hour (P5-R44). */
export const DELETION_ATTEMPTS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

/**
 * Counts one deletion attempt against the person's hourly allowance (P5-R44), in its own
 * transaction under the person's row lock, so attempts at once cannot all pass. Recorded in
 * `personal_data_exports` as kind `deletion` (finished at once: an attempt is never "running").
 */
async function takeDeletionAttempt(
  db: Db,
  userId: string,
  now: Date,
): Promise<'ok' | 'not_found' | 'rate_limited'> {
  return db.transaction(async (tx) => {
    const [person] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for('no key update');
    if (!person) return 'not_found';
    const recent = await tx.$count(
      personalDataExports,
      and(
        eq(personalDataExports.userId, userId),
        eq(personalDataExports.kind, 'deletion'),
        gt(personalDataExports.startedAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
    if (recent >= DELETION_ATTEMPTS_PER_HOUR) return 'rate_limited';
    await tx
      .insert(personalDataExports)
      .values({ userId, kind: 'deletion', startedAt: now, finishedAt: now });
    return 'ok';
  });
}

/**
 * The workspaces the person is the only owner of, from their workspaces' member rows; `lock`
 * takes those rows `FOR UPDATE` by id (L12).
 */
async function soleOwnerWorkspaces(
  q: Query,
  userId: string,
  lock: boolean,
): Promise<{ orphaned: string[]; current: Set<string> }> {
  const theirs = q
    .select({ orgId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const query = q
    .select({
      orgId: member.organizationId,
      userId: member.userId,
      role: member.role,
      workspace: organization.name,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(sql`${member.organizationId} in ${theirs}`)
    .orderBy(asc(member.id));
  const rows = lock ? await query.for('update', { of: member }) : await query;
  const isOwner = (role: string) => parseRoles(role).includes('owner');
  const memberships = rows.filter((r) => r.userId === userId);
  const orphaned = memberships
    .filter(
      (m) =>
        isOwner(m.role) &&
        !rows.some((o) => o.orgId === m.orgId && o.userId !== userId && isOwner(o.role)),
    )
    .map((m) => m.workspace);
  return { orphaned, current: new Set(memberships.map((m) => m.orgId)) };
}

/**
 * Deletes a person's account (GDPR erasure), in one transaction: their private data in every
 * workspace they belong to or still have rows in (conversations with messages and approvals,
 * skills with versions, runs, tokens, … any tenant table with `user_id`/`owner_user_id`),
 * invitations addressed to them, then the account itself (sessions, sign-in methods, memberships,
 * invitations they sent cascade). Usage records and the audit log keep the opaque user id only.
 * Refused while the person is the only owner of a workspace: it would be left without anyone able
 * to manage or delete it. The workspaces' member rows are locked first (L12), so two owners
 * leaving at once cannot both pass that check.
 *
 * Cost (P5-R44): finding the workspaces a former member still has rows in (`user_org_ids`) costs
 * one indexed probe per workspace of the whole deployment. So it runs last, only once the attempt
 * fits the person's hourly allowance (`DELETION_ATTEMPTS_PER_HOUR`) and a lock-free sole-owner
 * check passed; a refused attempt never reaches it. The check is repeated under the locks.
 *
 * Lock order: user row, then member rows by id, then the person's tenant rows workspace by
 * workspace. A workspace deletion (the auth hook) also takes its member rows by id before any
 * tenant row, so the two serialize on the shared member rows instead of deadlocking.
 */
export async function deleteAccount(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<DeleteAccountResult> {
  const attempt = await takeDeletionAttempt(db, userId, now);
  if (attempt !== 'ok') return { ok: false, code: attempt };
  const precheck = await soleOwnerWorkspaces(db, userId, false);
  if (precheck.orphaned.length > 0) {
    return { ok: false, code: 'sole_owner', workspaces: precheck.orphaned };
  }
  // Before any lock (P5-R37): a workspace the person has rows in now is in this list, member or
  // not; one they join meanwhile is a membership, read under the locks below.
  const known = await personOrgIds(db, userId);
  return db.transaction(async (tx): Promise<DeleteAccountResult> => {
    const [person] = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .for('update');
    if (!person) return { ok: false, code: 'not_found' };

    const { orphaned, current } = await soleOwnerWorkspaces(tx, userId, true);
    if (orphaned.length > 0) return { ok: false, code: 'sole_owner', workspaces: orphaned };

    const tables = await personalTables(tx);
    const former = await formerWorkspaces(tx, known, current);
    const orgIds = [...current, ...former.map((f) => f.orgId)];
    const erased = tables.filter((t) => !KEPT_ON_DELETION.has(t.table));
    for (const orgId of orgIds) {
      await enterOrg(tx, orgId);
      for (const t of erased) {
        await tx.execute(
          sql`delete from ${sql.identifier(t.table)} where ${personCol(t)} = ${userId}`,
        );
      }
      // Connections they made stay (the workspace's), without the Jira account they signed in
      // as; `created_by` keeps the opaque id, like the audit log.
      await tx
        .update(jiraConnections)
        .set({ accountId: null, accountName: null })
        .where(eq(jiraConnections.createdBy, userId));
      await recordAudit(tx, {
        orgId,
        actorUserId: userId,
        action: 'user.deleted',
        targetType: 'user',
        targetId: userId,
      });
    }
    // Not tenant tables: invitations addressed to them, pending sign-in checks for them.
    await tx.delete(invitation).where(sql`lower(${invitation.email}) = lower(${person.email})`);
    await tx
      .delete(verification)
      .where(
        or(
          sql`lower(${verification.identifier}) = lower(${person.email})`,
          eq(verification.value, userId),
        ),
      );
    // Last: sessions, sign-in methods, memberships and invitations they sent cascade.
    await tx.delete(user).where(eq(user.id, userId));
    return { ok: true, workspaces: orgIds.length };
  });
}

/** Exports one person may start per hour (L14 / P5-R37); one at a time. */
export const EXPORTS_PER_HOUR = 5;
/** An export still marked running after this long was abandoned (a crash): it no longer blocks. */
export const EXPORT_STALE_MS = 30 * 60_000;

export type OpenExportResult =
  | {
      ok: true;
      /** The document, piece by piece; marks the export finished when it ends or is closed. */
      chunks: AsyncGenerator<string>;
      /** Marks the export finished (idempotent): call it when the download is abandoned. */
      finish: () => Promise<void>;
    }
  | { ok: false; code: 'not_found' | 'export_in_progress' | 'export_rate_limited' };

/** Export kinds throttled separately (column `kind` of `personal_data_exports`). */
export type ExportKind = 'personal' | 'audit';

/**
 * Starts a throttled export of `kind`: one running per person, at most `EXPORTS_PER_HOUR` an
 * hour. The person's row is locked while deciding, so two requests at once cannot both start.
 * `produce` makes the document; the export is marked finished when it ends or is closed.
 */
export async function openThrottledExport(
  db: Db,
  userId: string,
  kind: ExportKind,
  produce: () => AsyncGenerator<string> | Promise<AsyncGenerator<string>>,
  now: Date = new Date(),
): Promise<OpenExportResult> {
  const opened = await db.transaction(
    async (tx): Promise<{ ok: true; id: string } | Exclude<OpenExportResult, { ok: true }>> => {
      const [person] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .for('no key update');
      if (!person) return { ok: false, code: 'not_found' };
      const recent = await tx
        .select({
          startedAt: personalDataExports.startedAt,
          finishedAt: personalDataExports.finishedAt,
        })
        .from(personalDataExports)
        .where(
          and(
            eq(personalDataExports.userId, userId),
            eq(personalDataExports.kind, kind),
            gt(personalDataExports.startedAt, new Date(now.getTime() - HOUR_MS)),
          ),
        );
      const staleBefore = now.getTime() - EXPORT_STALE_MS;
      if (recent.some((r) => r.finishedAt === null && r.startedAt.getTime() > staleBefore)) {
        return { ok: false, code: 'export_in_progress' };
      }
      if (recent.length >= EXPORTS_PER_HOUR) return { ok: false, code: 'export_rate_limited' };
      const [row] = await tx
        .insert(personalDataExports)
        .values({ userId, kind, startedAt: now })
        .returning({ id: personalDataExports.id });
      if (!row) throw new Error('export insert returned nothing');
      return { ok: true, id: row.id };
    },
  );
  if (!opened.ok) return opened;
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await db
      .update(personalDataExports)
      .set({ finishedAt: new Date() })
      .where(eq(personalDataExports.id, opened.id));
  };
  let source: AsyncGenerator<string>;
  try {
    source = await produce();
  } catch (e) {
    await finish();
    throw e;
  }
  const chunks = (async function* () {
    try {
      yield* source;
    } finally {
      await finish();
    }
  })();
  return { ok: true, chunks, finish };
}

/**
 * Starts a personal data export, throttled (an export reads every workspace the person was in).
 */
export function openUserExport(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<OpenExportResult> {
  return openThrottledExport(db, userId, 'personal', () => exportUserData(db, userId), now);
}
