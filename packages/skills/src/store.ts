import { canManageConnections } from '@agile/auth';
import { type Actor, recordAudit } from '@agile/connections';
import {
  type Db,
  deliveryChannels,
  isUniqueViolation,
  isUuid,
  skillRuns,
  skills,
  skillVersions,
  type Tx,
  user,
  withOrg,
} from '@agile/db';
import { and, asc, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import {
  type ParseResult,
  parseSkillDocument,
  type SkillDocument,
  type SkillIssue,
  withName,
} from './document';
import { builtinSkill } from './library';
import type { SkillOutput, SkillTrigger } from './schema';

export type SkillActor = Pick<Actor, 'orgId' | 'userId' | 'roles'>;
export type SkillLocale = 'en' | 'fr';

export interface SkillView {
  id: string;
  name: string;
  description: string;
  trigger: SkillTrigger;
  output: SkillOutput;
  visibility: 'private' | 'workspace';
  enabled: boolean;
  currentVersion: number;
  ownerUserId: string;
  /** The owner's display name (null once the account is gone). */
  ownerName: string | null;
  builtinKey: string | null;
  forkedFromId: string | null;
  channelId: string | null;
  updatedAt: Date;
  lastRun: { status: string; resultCode: string | null; finishedAt: Date | null } | null;
}

export type SkillFailure = {
  ok: false;
  code:
    | 'not_found'
    | 'forbidden'
    | 'invalid'
    | 'duplicate_name'
    | 'invalid_channel'
    | 'forbidden_output'
    | 'version_conflict';
  issues?: SkillIssue[];
};

const notFound: SkillFailure = { ok: false, code: 'not_found' };
const forbidden: SkillFailure = { ok: false, code: 'forbidden' };
const forbiddenOutput: SkillFailure = { ok: false, code: 'forbidden_output' };

/** A skill row as stored. */
export type SkillRow = typeof skills.$inferSelect;

const columns = {
  id: skills.id,
  name: skills.name,
  description: skills.description,
  trigger: skills.trigger,
  output: skills.output,
  visibility: skills.visibility,
  enabled: skills.enabled,
  currentVersion: skills.currentVersion,
  ownerUserId: skills.ownerUserId,
  ownerName: user.name,
  builtinKey: skills.builtinKey,
  forkedFromId: skills.forkedFromId,
  channelId: skills.channelId,
  updatedAt: skills.updatedAt,
};

/** Readable by the actor: their own skills and the ones shared with the workspace. */
const readableBy = (actor: SkillActor) =>
  and(
    eq(skills.orgId, actor.orgId),
    or(eq(skills.ownerUserId, actor.userId), eq(skills.visibility, 'workspace')),
  );

/** A skill with its current version's document, parsed. */
export interface LoadedSkill {
  skill: SkillRow;
  /** The owner's display name (null once the account is gone). */
  ownerName: string | null;
  document: string;
  parsed: ParseResult;
}

/**
 * The one loader of skills with their current document: a single joined query (skill, current
 * version, owner name) for every caller — catalog, planner, runs, pages — never one query per
 * skill. Runs inside the caller's tenant transaction (`withOrg`).
 *
 * Internal use only (packages and server code, never with request input as the filter): it
 * applies no authorization. RLS bounds it to the tenant, but within the tenant it returns every
 * member's skills, private ones included. Callers MUST scope `where` themselves (e.g. owner,
 * enabled, readable-by-actor) before showing or running anything it returns.
 */
export async function loadSkillsWithDocuments(tx: Tx, where?: SQL): Promise<LoadedSkill[]> {
  const rows = await tx
    .select({ skill: skills, ownerName: user.name, document: skillVersions.document })
    .from(skills)
    .innerJoin(
      skillVersions,
      and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, skills.currentVersion)),
    )
    .leftJoin(user, eq(user.id, skills.ownerUserId))
    .where(where)
    .orderBy(asc(skills.name), asc(skills.id));
  return rows.map((r) => ({ ...r, parsed: parseSkillDocument(r.document) }));
}

async function lastRuns(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, SkillView['lastRun']>();
  const rows = await tx
    .selectDistinctOn([skillRuns.skillId], {
      skillId: skillRuns.skillId,
      status: skillRuns.status,
      resultCode: skillRuns.resultCode,
      finishedAt: skillRuns.finishedAt,
    })
    .from(skillRuns)
    .where(inArray(skillRuns.skillId, ids))
    .orderBy(skillRuns.skillId, desc(skillRuns.createdAt));
  return new Map(
    rows.map((r) => [
      r.skillId,
      { status: r.status, resultCode: r.resultCode, finishedAt: r.finishedAt },
    ]),
  );
}

/** The actor's skills, and the ones other members shared with the workspace. */
export async function listSkills(
  db: Db,
  actor: SkillActor,
): Promise<{ mine: SkillView[]; shared: SkillView[] }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select(columns)
      .from(skills)
      .leftJoin(user, eq(user.id, skills.ownerUserId))
      .where(readableBy(actor))
      .orderBy(skills.name);
    const runs = await lastRuns(
      tx,
      rows.map((r) => r.id),
    );
    const views = rows.map((r) => ({ ...r, lastRun: runs.get(r.id) ?? null }));
    return {
      mine: views.filter((v) => v.ownerUserId === actor.userId),
      shared: views.filter((v) => v.ownerUserId !== actor.userId),
    };
  });
}

export interface SkillDetail {
  skill: SkillView;
  document: string;
  versions: { version: number; createdAt: Date; createdBy: string }[];
  canEdit: boolean;
  canDelete: boolean;
}

const canDelete = (actor: SkillActor, row: { ownerUserId: string; visibility: string }) =>
  row.ownerUserId === actor.userId ||
  (row.visibility === 'workspace' && canManageConnections(actor.roles));

/** One readable skill with its current document and version list; null when not readable. */
export async function getSkill(db: Db, actor: SkillActor, id: string): Promise<SkillDetail | null> {
  if (!isUuid(id)) return null;
  return withOrg(db, actor.orgId, async (tx) => {
    const [loaded] = await loadSkillsWithDocuments(tx, and(readableBy(actor), eq(skills.id, id)));
    if (!loaded) return null;
    const versions = await tx
      .select({
        version: skillVersions.version,
        createdAt: skillVersions.createdAt,
        createdBy: skillVersions.createdBy,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, id))
      .orderBy(desc(skillVersions.version));
    const runs = await lastRuns(tx, [id]);
    const s = loaded.skill;
    return {
      skill: {
        id: s.id,
        name: s.name,
        description: s.description,
        trigger: s.trigger,
        output: s.output,
        visibility: s.visibility,
        enabled: s.enabled,
        currentVersion: s.currentVersion,
        ownerUserId: s.ownerUserId,
        ownerName: loaded.ownerName,
        builtinKey: s.builtinKey,
        forkedFromId: s.forkedFromId,
        channelId: s.channelId,
        updatedAt: s.updatedAt,
        lastRun: runs.get(id) ?? null,
      },
      document: loaded.document,
      versions,
      canEdit: s.ownerUserId === actor.userId,
      canDelete: canDelete(actor, s),
    };
  });
}

/** One saved version's document (to view or restore it); null when not readable. */
export async function getSkillVersion(
  db: Db,
  actor: SkillActor,
  id: string,
  version: number,
): Promise<string | null> {
  if (!isUuid(id) || !Number.isSafeInteger(version)) return null;
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ document: skillVersions.document })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(and(readableBy(actor), eq(skills.id, id), eq(skillVersions.version, version)));
    return row?.document ?? null;
  });
}

const postsToChannel = (output: SkillOutput) => output === 'slack' || output === 'teams';

/**
 * Slack/Teams outputs post where workspace admins chose: only workspace owners/admins may own
 * such a skill (P4-R4, until Phase 5 roles). The run re-checks the owner's role at run time.
 */
const outputAllowed = (actor: SkillActor, output: SkillOutput) =>
  !postsToChannel(output) || canManageConnections(actor.roles);

/**
 * Slack/Teams outputs need a channel of that kind in this workspace; other outputs none.
 * `skills.channel_id` has no foreign key, so this check is what keeps it in-tenant.
 */
async function checkChannel(
  tx: Tx,
  orgId: string,
  output: SkillOutput,
  channelId: string | null,
): Promise<boolean> {
  if (!postsToChannel(output)) return channelId === null;
  if (!channelId || !isUuid(channelId)) return false;
  const [row] = await tx
    .select({ id: deliveryChannels.id })
    .from(deliveryChannels)
    .where(
      and(
        eq(deliveryChannels.orgId, orgId),
        eq(deliveryChannels.id, channelId),
        eq(deliveryChannels.kind, output),
      ),
    );
  return Boolean(row);
}

/** Columns mirrored from the document's frontmatter. */
const mirror = (skill: SkillDocument) => ({
  name: skill.frontmatter.name,
  description: skill.frontmatter.description,
  trigger: skill.frontmatter.trigger,
  output: skill.frontmatter.output,
});

const parse = (document: string): { ok: true; skill: SkillDocument } | SkillFailure => {
  const parsed = parseSkillDocument(document);
  return parsed.ok ? parsed : { ok: false, code: 'invalid', issues: parsed.issues };
};

/**
 * Creates a skill (version 1) owned by the actor. Any member may create skills. A copy
 * (`forkedFrom`) starts disabled: its new owner turns it on after reading it (P4-R8).
 */
export async function createSkill(
  db: Db,
  actor: SkillActor,
  input: {
    document: string;
    channelId?: string | null;
    builtinKey?: string | null;
    forkedFrom?: { id: string; version: number } | null;
    /** The owner's UI language (fixed wording of emails and posts). */
    locale?: SkillLocale;
    now: Date;
  },
): Promise<{ ok: true; id: string } | SkillFailure> {
  const parsed = parse(input.document);
  if (!parsed.ok) return parsed;
  if (!outputAllowed(actor, parsed.skill.frontmatter.output)) return forbiddenOutput;
  const channelId = input.channelId ?? null;
  const forkedFrom = input.forkedFrom ?? null;
  if (forkedFrom && !isUuid(forkedFrom.id)) return notFound;
  // Only real built-ins: the catalog hides the stock skill behind any skill carrying its key.
  if (input.builtinKey != null && !builtinSkill(input.builtinKey)) {
    return { ok: false, code: 'invalid' };
  }
  try {
    return await withOrg(db, actor.orgId, async (tx) => {
      // `forked_from_id` has no foreign key: the source must be a skill this actor can read.
      if (forkedFrom) {
        const [source] = await tx
          .select({ id: skills.id })
          .from(skills)
          .where(and(readableBy(actor), eq(skills.id, forkedFrom.id)));
        if (!source) return notFound;
      }
      if (!(await checkChannel(tx, actor.orgId, parsed.skill.frontmatter.output, channelId))) {
        return { ok: false, code: 'invalid_channel' } as const;
      }
      const [row] = await tx
        .insert(skills)
        .values({
          orgId: actor.orgId,
          ownerUserId: actor.userId,
          ...mirror(parsed.skill),
          channelId,
          enabled: !forkedFrom,
          locale: input.locale ?? 'en',
          builtinKey: input.builtinKey ?? null,
          forkedFromId: forkedFrom?.id ?? null,
          forkedFromVersion: forkedFrom?.version ?? null,
          scheduleCursor: input.now,
        })
        .returning({ id: skills.id });
      if (!row) throw new Error('skill insert returned nothing');
      await tx.insert(skillVersions).values({
        orgId: actor.orgId,
        skillId: row.id,
        version: 1,
        document: input.document,
        createdBy: actor.userId,
      });
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: forkedFrom || input.builtinKey ? 'skill.forked' : 'skill.created',
        targetType: 'skill',
        targetId: row.id,
        metadata: {
          name: parsed.skill.frontmatter.name,
          trigger: parsed.skill.frontmatter.trigger,
          output: parsed.skill.frontmatter.output,
          ...(input.builtinKey ? { builtinKey: input.builtinKey } : {}),
          ...(forkedFrom ? { forkedFromId: forkedFrom.id } : {}),
        },
      });
      return { ok: true, id: row.id } as const;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: 'duplicate_name' };
    throw e;
  }
}

/** Locks the actor's own skill for an update; a readable skill of someone else is `forbidden`. */
async function lockOwn(tx: Tx, actor: SkillActor, id: string): Promise<SkillRow | SkillFailure> {
  if (!isUuid(id)) return notFound;
  const [row] = await tx
    .select()
    .from(skills)
    .where(and(readableBy(actor), eq(skills.id, id)))
    .for('update');
  if (!row) return notFound;
  if (row.ownerUserId !== actor.userId) return forbidden;
  return row;
}

/** The unique index a Postgres unique_violation hit (drizzle wraps it in `cause`), else null. */
function uniqueConstraint(e: unknown): string | null {
  if (!isUniqueViolation(e)) return null;
  for (let cur: unknown = e; cur; cur = (cur as { cause?: unknown }).cause) {
    const name = (cur as { constraint_name?: unknown }).constraint_name;
    if (typeof name === 'string') return name;
  }
  return null;
}

const isFailure = (v: unknown): v is SkillFailure =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

/**
 * Saves a new version of the actor's own skill. `baseVersion` is the version the editor started
 * from: if someone (another tab) saved meanwhile, the save is refused instead of overwriting it.
 * A changed schedule restarts from now; a changed alert condition forgets its matched boards.
 */
export async function updateSkill(
  db: Db,
  actor: SkillActor,
  id: string,
  input: {
    document: string;
    channelId?: string | null;
    baseVersion: number;
    locale?: SkillLocale;
    now: Date;
  },
): Promise<{ ok: true; version: number } | SkillFailure> {
  const parsed = parse(input.document);
  if (!parsed.ok) return parsed;
  try {
    return await withOrg(db, actor.orgId, async (tx) => {
      const row = await lockOwn(tx, actor, id);
      if (isFailure(row)) return row;
      if (row.currentVersion !== input.baseVersion) {
        return { ok: false, code: 'version_conflict' } as const;
      }
      const f = parsed.skill.frontmatter;
      if (!outputAllowed(actor, f.output)) return forbiddenOutput;
      const channelId = input.channelId ?? null;
      if (!(await checkChannel(tx, actor.orgId, f.output, channelId))) {
        return { ok: false, code: 'invalid_channel' } as const;
      }
      const previous = await currentDocument(tx, id, row.currentVersion);
      const before = previous ? parseSkillDocument(previous) : null;
      const old = before?.ok ? before.skill.frontmatter : null;
      const version = row.currentVersion + 1;
      await tx.insert(skillVersions).values({
        orgId: actor.orgId,
        skillId: id,
        version,
        document: input.document,
        createdBy: actor.userId,
      });
      const scheduleChanged = JSON.stringify(old?.schedule) !== JSON.stringify(f.schedule);
      const alertChanged =
        JSON.stringify(old?.alert) !== JSON.stringify(f.alert) ||
        JSON.stringify(old?.scope) !== JSON.stringify(f.scope);
      await tx
        .update(skills)
        .set({
          ...mirror(parsed.skill),
          channelId,
          ...(input.locale ? { locale: input.locale } : {}),
          currentVersion: version,
          ...(scheduleChanged ? { scheduleCursor: input.now } : {}),
          ...(alertChanged ? { alertBoards: [], alertFiredAt: null } : {}),
        })
        .where(eq(skills.id, id));
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'skill.updated',
        targetType: 'skill',
        targetId: id,
        metadata: { name: f.name, version, trigger: f.trigger, output: f.output },
      });
      return { ok: true, version } as const;
    });
  } catch (e) {
    // The row lock makes a version clash unlikely; if one slips through it is still a conflict.
    const constraint = uniqueConstraint(e);
    if (constraint === 'skill_versions_skill_version_uq') {
      return { ok: false, code: 'version_conflict' };
    }
    if (constraint === 'skills_owner_name_uq') return { ok: false, code: 'duplicate_name' };
    throw e;
  }
}

/** A free name for a copy in the actor's skills: the same name, else `-copy`, `-copy-2`… */
async function freeName(tx: Tx, actor: SkillActor, name: string): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ name: skills.name })
        .from(skills)
        .where(and(eq(skills.orgId, actor.orgId), eq(skills.ownerUserId, actor.userId)))
    ).map((r) => r.name),
  );
  if (!taken.has(name)) return name;
  const base = name.slice(0, 55);
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? `${base}-copy` : `${base}-copy-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}

/**
 * Copies a skill the actor can read (their own or a shared one) into a new private skill of
 * theirs. The copy is a snapshot: later edits of the original do not reach it. Shared skills
 * only reach another member's assistant this way, after they chose to copy them; the copy starts
 * disabled (P4-R8).
 */
export async function forkSkill(
  db: Db,
  actor: SkillActor,
  id: string,
  now: Date,
  locale?: SkillLocale,
): Promise<{ ok: true; id: string } | SkillFailure> {
  const source = await getSkill(db, actor, id);
  if (!source) return notFound;
  const name = await withOrg(db, actor.orgId, (tx) => freeName(tx, actor, source.skill.name));
  return createSkill(db, actor, {
    document: withName(source.document, name),
    // The channel belongs to the workspace, so the copy can keep it.
    channelId: source.skill.channelId,
    forkedFrom: { id, version: source.skill.currentVersion },
    locale,
    now,
  });
}

/** Copies a built-in skill into an editable skill of the actor's. */
export async function copyBuiltinSkill(
  db: Db,
  actor: SkillActor,
  key: string,
  now: Date,
  locale?: SkillLocale,
): Promise<{ ok: true; id: string } | SkillFailure> {
  const builtin = builtinSkill(key);
  if (!builtin) return notFound;
  const name = await withOrg(db, actor.orgId, (tx) => freeName(tx, actor, builtin.key));
  return createSkill(db, actor, {
    document: withName(builtin.document, name),
    builtinKey: builtin.key,
    locale,
    now,
  });
}

/** Shares the actor's own skill with the workspace (read and copy only), or makes it private. */
export async function setSkillVisibility(
  db: Db,
  actor: SkillActor,
  id: string,
  visibility: 'private' | 'workspace',
): Promise<{ ok: true } | SkillFailure> {
  return withOrg(db, actor.orgId, async (tx) => {
    const row = await lockOwn(tx, actor, id);
    if (isFailure(row)) return row;
    await tx.update(skills).set({ visibility }).where(eq(skills.id, id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'skill.visibility_changed',
      targetType: 'skill',
      targetId: id,
      metadata: { name: row.name, visibility },
    });
    return { ok: true } as const;
  });
}

/** Turns the actor's own skill on or off (off: not offered to the assistant, never scheduled). */
export async function setSkillEnabled(
  db: Db,
  actor: SkillActor,
  id: string,
  enabled: boolean,
  now: Date,
): Promise<{ ok: true } | SkillFailure> {
  return withOrg(db, actor.orgId, async (tx) => {
    const row = await lockOwn(tx, actor, id);
    if (isFailure(row)) return row;
    // Re-enabling never runs the times missed while it was off.
    await tx
      .update(skills)
      .set({ enabled, ...(enabled && !row.enabled ? { scheduleCursor: now } : {}) })
      .where(eq(skills.id, id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'skill.enabled_changed',
      targetType: 'skill',
      targetId: id,
      metadata: { name: row.name, enabled },
    });
    return { ok: true } as const;
  });
}

/** Deletes a skill: its owner, or a workspace owner/admin for a shared one (moderation). */
export async function deleteSkill(
  db: Db,
  actor: SkillActor,
  id: string,
): Promise<{ ok: true } | SkillFailure> {
  if (!isUuid(id)) return notFound;
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({
        ownerUserId: skills.ownerUserId,
        visibility: skills.visibility,
        name: skills.name,
      })
      .from(skills)
      .where(and(readableBy(actor), eq(skills.id, id)))
      .for('update');
    if (!row) return notFound;
    if (!canDelete(actor, row)) return forbidden;
    await tx.delete(skills).where(eq(skills.id, id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'skill.deleted',
      targetType: 'skill',
      targetId: id,
      metadata: { name: row.name, ownerUserId: row.ownerUserId },
    });
    return { ok: true } as const;
  });
}

/** One version's document of a skill (inside the caller's tenant transaction). */
export async function currentDocument(tx: Tx, skillId: string, version: number) {
  const [row] = await tx
    .select({ document: skillVersions.document })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)));
  return row?.document ?? null;
}
