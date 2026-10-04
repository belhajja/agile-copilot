import { parseRoles } from '@agile/auth';
import {
  account,
  agentConversations,
  agentMessages,
  agentUsage,
  auditLog,
  type Db,
  invitation,
  member,
  organization,
  recordAudit,
  session,
  skillRuns,
  skills,
  skillVersions,
  type Tx,
  user,
  verification,
  withOrg,
} from '@agile/db';
import { and, asc, eq, gt, isNull, or, type SQL, sql } from 'drizzle-orm';
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
  return (await q.execute(sql`
    select c.table_name as "table", c.column_name as "column"
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.column_name in ('user_id', 'owner_user_id')
      and exists (select 1 from information_schema.columns o
        where o.table_schema = 'public' and o.table_name = c.table_name and o.column_name = 'org_id')
    order by c.table_name, c.column_name
  `)) as unknown as PersonalTable[];
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
 * Workspaces the person is no longer a member of but still has rows in (M2): a former member's
 * conversations, skills, runs, usage or audit entries stay until erased. RLS shows one workspace at
 * a time, so each is checked under its own context, in one transaction.
 */
async function formerWorkspaces(
  tx: Tx,
  userId: string,
  tables: PersonalTable[],
  current: ReadonlySet<string>,
): Promise<Workspace[]> {
  const checks = [
    ...tables.map(
      (t) =>
        sql`exists (select 1 from ${sql.identifier(t.table)} where ${personCol(t)} = ${userId})`,
    ),
    sql`exists (select 1 from ${auditLog} where ${auditLog.actorUserId} = ${userId})`,
  ];
  const all = await tx
    .select({ orgId: organization.id, workspace: organization.name })
    .from(organization)
    .orderBy(asc(organization.name), asc(organization.id));
  const found: Workspace[] = [];
  for (const org of all) {
    if (current.has(org.orgId)) continue;
    await enterOrg(tx, org.orgId);
    const [row] = (await tx.execute(
      sql`select (${sql.join(checks, sql` or `)}) as "found"`,
    )) as unknown as { found: boolean }[];
    if (row?.found) found.push(org);
  }
  return found;
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

  // Any other tenant table naming the person (later tables included), secret columns dropped.
  yield ',"other":{';
  let firstTable = true;
  for (const t of tables) {
    if (EXPORTED_EXPLICITLY.has(t.table)) continue;
    const rows = paged(
      (after: string | undefined) =>
        inOrg(
          async (tx) =>
            (await tx.execute(sql`
              select r.ctid::text as "key", to_jsonb(r) as "row"
              from ${sql.identifier(t.table)} r
              where ${personCol(t)} = ${userId}
                ${after === undefined ? sql`` : sql`and r.ctid > ${after}::tid`}
              order by r.ctid
              limit ${EXPORT_PAGE_SIZE}
            `)) as unknown as { key: string; row: Record<string, unknown> }[],
        ),
      (r) => r.key,
    );
    let first = true;
    for await (const r of rows) {
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
  const former = await db.transaction((tx) =>
    formerWorkspaces(tx, userId, tables, new Set(memberships.map((m) => m.orgId))),
  );
  const workspaces = [
    ...memberships.map((m) => ({ ...m, role: parseRoles(m.role), member: true })),
    ...former.map((f) => ({ ...f, role: [], joinedAt: null, member: false })),
  ];

  yield `{"exportedAt":${json(new Date())},"user":${json(profile)},"signInMethods":${json(signInMethods)},"sessions":${json(sessions)},"invitations":${json({ sent, received })},"workspaces":`;
  yield* jsonArray(workspaces, (ws) => workspaceSection(db, userId, ws, tables));
  yield '}';
}

export type DeleteAccountResult =
  | { ok: true; workspaces: number }
  | { ok: false; code: 'sole_owner'; workspaces: string[] }
  | { ok: false; code: 'not_found' };

/**
 * Deletes a person's account (GDPR erasure), in one transaction: their private data in every
 * workspace they belong to or still have rows in (conversations with messages and approvals,
 * skills with versions, runs, tokens, … any tenant table with `user_id`/`owner_user_id`),
 * invitations addressed to them, then the account itself (sessions, sign-in methods, memberships,
 * invitations they sent cascade). Usage records and the audit log keep the opaque user id only.
 * Refused while the person is the only owner of a workspace: it would be left without anyone able
 * to manage or delete it. The workspaces' member rows are locked first (L12), so two owners
 * leaving at once cannot both pass that check.
 */
export async function deleteAccount(db: Db, userId: string): Promise<DeleteAccountResult> {
  return db.transaction(async (tx): Promise<DeleteAccountResult> => {
    const [person] = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .for('update');
    if (!person) return { ok: false, code: 'not_found' };

    const theirs = tx
      .select({ orgId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId));
    const rows = await tx
      .select({
        orgId: member.organizationId,
        userId: member.userId,
        role: member.role,
        workspace: organization.name,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(sql`${member.organizationId} in ${theirs}`)
      .orderBy(asc(member.id))
      .for('update', { of: member });
    const isOwner = (role: string) => parseRoles(role).includes('owner');
    const memberships = rows.filter((r) => r.userId === userId);
    const orphaned = memberships
      .filter(
        (m) =>
          isOwner(m.role) &&
          !rows.some((o) => o.orgId === m.orgId && o.userId !== userId && isOwner(o.role)),
      )
      .map((m) => m.workspace);
    if (orphaned.length > 0) return { ok: false, code: 'sole_owner', workspaces: orphaned };

    const tables = await personalTables(tx);
    const current = new Set(memberships.map((m) => m.orgId));
    const former = await formerWorkspaces(tx, userId, tables, current);
    const orgIds = [...current, ...former.map((f) => f.orgId)];
    const erased = tables.filter((t) => !KEPT_ON_DELETION.has(t.table));
    for (const orgId of orgIds) {
      await enterOrg(tx, orgId);
      for (const t of erased) {
        await tx.execute(
          sql`delete from ${sql.identifier(t.table)} where ${personCol(t)} = ${userId}`,
        );
      }
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
