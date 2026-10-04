import { type Db, deliveryChannels, isUuid, skillRuns, skills, type Tx, withOrg } from '@agile/db';
import type { SkillActor } from '@agile/skills';
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';

/** Background runs per workspace and rolling 24 hours (schedules, alerts and "Run now"). */
export const DEFAULT_DAILY_RUN_LIMIT = 50;
/** A run still queued or running after this long was lost (worker crash): it is closed as failed. */
export const STALE_RUN_MINUTES = 30;
/**
 * A run still queued after this long was probably never sent to the queue (the send failed after
 * the commit): each tick sends it again until it is claimed or closed as stale (P4-R19).
 */
export const RESEND_QUEUED_MINUTES = 10;

export type RunTrigger = 'schedule' | 'alert' | 'manual';

export interface RunView {
  id: string;
  trigger: RunTrigger;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
  resultCode: string | null;
  /** The report: the skill owner's only (P4-R1), null for anyone else. */
  output: string | null;
  /** Delivery outcomes: the skill owner's only (P4-R1), empty for anyone else. */
  deliveries: Record<string, string>;
  version: number;
  scheduledFor: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Runs of the last 24 hours that cost (or may cost) a model call. */
async function runsToday(tx: Tx, orgId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(skillRuns)
    .where(
      and(
        eq(skillRuns.orgId, orgId),
        ne(skillRuns.status, 'skipped'),
        gte(skillRuns.createdAt, new Date(now.getTime() - 24 * 3_600_000)),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Records a run to do, inside the caller's tenant transaction. Over the workspace's daily limit
 * the run is still recorded, as `skipped` with code `daily_limit`, so the owner sees why nothing
 * came; `skip` records it as skipped with that code whatever the count (e.g. `owner_left`).
 * Scheduled runs are unique per scheduled time: a second attempt returns null, as does a skill
 * that is not in this workspace.
 *
 * The skill's output and channel are snapshotted into the run (P4-R5): delivery uses them, not a
 * later edit. The channel is kept only when it is in this workspace (foreign keys bypass RLS).
 */
export async function createRun(
  tx: Tx,
  orgId: string,
  input: {
    skillId: string;
    version: number;
    trigger: RunTrigger;
    scheduledFor?: Date | null;
    context?: Record<string, unknown>;
    now: Date;
    dailyLimit: number;
    skip?: string;
  },
): Promise<{ id: string; queued: boolean } | null> {
  if (!isUuid(input.skillId)) return null;
  const [skill] = await tx
    .select({ output: skills.output, channelId: deliveryChannels.id })
    .from(skills)
    .leftJoin(
      deliveryChannels,
      and(eq(deliveryChannels.id, skills.channelId), eq(deliveryChannels.orgId, orgId)),
    )
    .where(and(eq(skills.orgId, orgId), eq(skills.id, input.skillId)));
  if (!skill) return null;
  // Serialises the count-then-insert of one workspace (two ticks or two "Run now" at once): the
  // lock is held until commit, and under READ COMMITTED the count that follows sees every run
  // committed by the previous holder.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skill_runs:${orgId}`}))`);
  const skipCode =
    input.skip ??
    ((await runsToday(tx, orgId, input.now)) >= input.dailyLimit ? 'daily_limit' : null);
  const [row] = await tx
    .insert(skillRuns)
    .values({
      orgId,
      skillId: input.skillId,
      version: input.version,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor ?? null,
      context: input.context ?? {},
      outputKind: skill.output,
      channelId: skill.channelId,
      // The caller's clock (the worker's), the one the daily window is counted with.
      createdAt: input.now,
      ...(skipCode
        ? { status: 'skipped' as const, resultCode: skipCode, finishedAt: input.now }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: skillRuns.id });
  if (!row) return null;
  return { id: row.id, queued: !skipCode };
}

/** Moves a queued run to running; false when another worker already took it (or it is gone). */
export async function claimRun(db: Db, orgId: string, runId: string): Promise<boolean> {
  if (!isUuid(runId)) return false;
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .update(skillRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(skillRuns.id, runId), eq(skillRuns.status, 'queued')))
      .returning({ id: skillRuns.id }),
  );
  return rows.length > 0;
}

/** Stores a run's outcome (a code, never an error message). */
export async function finishRun(
  db: Db,
  orgId: string,
  runId: string,
  outcome: {
    status: 'succeeded' | 'failed' | 'skipped';
    resultCode?: string | null;
    output?: string | null;
    deliveries?: Record<string, string>;
  },
): Promise<void> {
  if (!isUuid(runId)) return;
  await withOrg(db, orgId, (tx) =>
    tx
      .update(skillRuns)
      .set({
        status: outcome.status,
        resultCode: outcome.resultCode ?? null,
        output: outcome.output ?? null,
        deliveries: outcome.deliveries ?? {},
        finishedAt: new Date(),
      })
      .where(eq(skillRuns.id, runId)),
  );
}

/** Closes runs left queued or running by a crashed worker. */
export async function closeStaleRuns(db: Db, orgId: string, now: Date): Promise<number> {
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .update(skillRuns)
      .set({ status: 'failed', resultCode: 'interrupted', finishedAt: now })
      .where(
        and(
          eq(skillRuns.orgId, orgId),
          inArray(skillRuns.status, ['queued', 'running']),
          lt(skillRuns.createdAt, new Date(now.getTime() - STALE_RUN_MINUTES * 60_000)),
        ),
      )
      .returning({ id: skillRuns.id }),
  );
  return rows.length;
}

/**
 * Runs still queued after `RESEND_QUEUED_MINUTES` (and not yet stale): their job may never have
 * been sent. Sending one again is harmless: `claimRun` lets only one worker run it.
 */
export async function queuedRunsToResend(db: Db, orgId: string, now: Date): Promise<string[]> {
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .select({ id: skillRuns.id })
      .from(skillRuns)
      .where(
        and(
          eq(skillRuns.orgId, orgId),
          eq(skillRuns.status, 'queued'),
          lt(skillRuns.createdAt, new Date(now.getTime() - RESEND_QUEUED_MINUTES * 60_000)),
        ),
      )
      .orderBy(skillRuns.createdAt),
  );
  return rows.map((r) => r.id);
}

/**
 * The latest runs of a skill the actor can read (their own, or one shared with the workspace).
 * Reports and delivery outcomes are the skill owner's only (P4-R1): an owner's or admin's run may
 * read live Jira beyond the selected boards, so anyone else (workspace owners and admins too)
 * sees the status and result code only.
 */
export async function listRuns(
  db: Db,
  actor: SkillActor,
  skillId: string,
  limit = 20,
): Promise<RunView[]> {
  if (!isUuid(skillId)) return [];
  return withOrg(db, actor.orgId, async (tx) => {
    const [skill] = await tx
      .select({ ownerUserId: skills.ownerUserId })
      .from(skills)
      .where(
        and(
          eq(skills.orgId, actor.orgId),
          eq(skills.id, skillId),
          or(eq(skills.ownerUserId, actor.userId), eq(skills.visibility, 'workspace')),
        ),
      );
    if (!skill) return [];
    const isOwner = skill.ownerUserId === actor.userId;
    const rows = await tx
      .select({
        id: skillRuns.id,
        trigger: skillRuns.trigger,
        status: skillRuns.status,
        resultCode: skillRuns.resultCode,
        output: skillRuns.output,
        deliveries: skillRuns.deliveries,
        version: skillRuns.version,
        scheduledFor: skillRuns.scheduledFor,
        createdAt: skillRuns.createdAt,
        finishedAt: skillRuns.finishedAt,
      })
      .from(skillRuns)
      .where(and(eq(skillRuns.orgId, actor.orgId), eq(skillRuns.skillId, skillId)))
      .orderBy(desc(skillRuns.createdAt))
      .limit(limit);
    return isOwner ? rows : rows.map((r) => ({ ...r, output: null, deliveries: {} }));
  });
}
