import { type Db, deliveryChannels, isUuid, skillRuns, skills, type Tx, withOrg } from '@agile/db';
import type { SkillActor } from '@agile/skills';
import { and, desc, eq, gte, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import type { RunResultCode, RunSkipCode } from './codes';

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

/** "Run now" runs per user and rolling 24 hours (P4-R30): one member cannot use up the day. */
export const SKILL_MANUAL_RUNS_PER_USER = 10;

/**
 * The part of the workspace's daily limit one owner's runs (schedules, alerts and "Run now") may
 * use (P4-R30): half of it, and never fewer than 5 runs. The workspace limit still binds.
 */
export const ownerRunShare = (dailyLimit: number) => Math.max(5, Math.ceil(dailyLimit / 2));

/**
 * Failed runs that ended before any model call (the owner's role refused the output, an invalid
 * document, no model): like skipped runs, they cost nothing and count toward no limit (P4-R30).
 */
const PRE_MODEL_FAILURES = [
  'forbidden_role',
  'invalid_skill',
  'no_llm',
] as const satisfies readonly RunResultCode[];

/**
 * Runs of the last 24 hours that cost (or may cost) a model call: in the workspace, of this
 * owner's skills, and of their "Run now" requests ("Run now" is the owner's only).
 */
async function runsToday(tx: Tx, orgId: string, ownerUserId: string, now: Date) {
  const [row] = await tx
    .select({
      workspace: sql<number>`count(*)::int`,
      owner: sql<number>`(count(*) filter (where ${skills.ownerUserId} = ${ownerUserId}))::int`,
      manual: sql<number>`(count(*) filter (where ${skills.ownerUserId} = ${ownerUserId} and ${skillRuns.trigger} = 'manual'))::int`,
    })
    .from(skillRuns)
    .innerJoin(skills, eq(skills.id, skillRuns.skillId))
    .where(
      and(
        eq(skillRuns.orgId, orgId),
        ne(skillRuns.status, 'skipped'),
        or(
          ne(skillRuns.status, 'failed'),
          isNull(skillRuns.resultCode),
          notInArray(skillRuns.resultCode, [...PRE_MODEL_FAILURES]),
        ),
        gte(skillRuns.createdAt, new Date(now.getTime() - 24 * 3_600_000)),
      ),
    );
  return { workspace: row?.workspace ?? 0, owner: row?.owner ?? 0, manual: row?.manual ?? 0 };
}

/** Why a run is recorded as skipped instead of queued, from the counts above (P4-R30). */
function limitReached(
  counts: Awaited<ReturnType<typeof runsToday>>,
  trigger: RunTrigger,
  dailyLimit: number,
): RunSkipCode | null {
  if (counts.workspace >= dailyLimit) return 'daily_limit';
  if (counts.owner >= ownerRunShare(dailyLimit)) return 'owner_limit';
  if (trigger === 'manual' && counts.manual >= SKILL_MANUAL_RUNS_PER_USER) return 'user_limit';
  return null;
}

/**
 * Records a run to do, inside the caller's tenant transaction. Over a limit the run is still
 * recorded, as `skipped` with the limit's code (`daily_limit` for the workspace, `owner_limit` for
 * the owner's share of it, `user_limit` for the owner's "Run now" allowance), so the owner sees why
 * nothing came; `skip` records it as skipped with that code whatever the counts (e.g.
 * `owner_left`). Scheduled runs are unique per scheduled time: a second attempt returns null, as
 * does a skill that is not in this workspace.
 *
 * The skill's output and channel are snapshotted into the run (P4-R5): delivery uses them, not a
 * later edit. The channel is kept only when it is in this workspace (foreign keys bypass RLS); an
 * email run keeps the workspace's SMTP server of the moment.
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
    skip?: RunSkipCode | 'owner_left';
  },
): Promise<{ id: string; queued: boolean; skipped: RunSkipCode | 'owner_left' | null } | null> {
  if (!isUuid(input.skillId)) return null;
  const [skill] = await tx
    .select({
      output: skills.output,
      ownerUserId: skills.ownerUserId,
      channelId: deliveryChannels.id,
    })
    .from(skills)
    .leftJoin(
      deliveryChannels,
      and(eq(deliveryChannels.id, skills.channelId), eq(deliveryChannels.orgId, orgId)),
    )
    .where(and(eq(skills.orgId, orgId), eq(skills.id, input.skillId)));
  if (!skill) return null;
  let channelId = skill.channelId;
  if (skill.output === 'email') {
    // One SMTP server per workspace: the run is delivered through the one there is now.
    const [smtp] = await tx
      .select({ id: deliveryChannels.id })
      .from(deliveryChannels)
      .where(and(eq(deliveryChannels.orgId, orgId), eq(deliveryChannels.kind, 'smtp')));
    channelId = smtp?.id ?? null;
  }
  // Serialises the count-then-insert of one workspace (two ticks or two "Run now" at once): the
  // lock is held until commit, and under READ COMMITTED the count that follows sees every run
  // committed by the previous holder.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skill_runs:${orgId}`}))`);
  const skipCode =
    input.skip ??
    limitReached(
      await runsToday(tx, orgId, skill.ownerUserId, input.now),
      input.trigger,
      input.dailyLimit,
    );
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
      channelId,
      // The caller's clock (the worker's), the one the daily window is counted with.
      createdAt: input.now,
      ...(skipCode
        ? { status: 'skipped' as const, resultCode: skipCode, finishedAt: input.now }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: skillRuns.id });
  if (!row) return null;
  return { id: row.id, queued: !skipCode, skipped: skipCode };
}

/**
 * Moves a queued run to running at `now` (the worker's clock, the one `createRun` and
 * `closeStaleRuns` use); false when another worker already took it (or it is gone).
 */
export async function claimRun(db: Db, orgId: string, runId: string, now: Date): Promise<boolean> {
  if (!isUuid(runId)) return false;
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .update(skillRuns)
      .set({ status: 'running', startedAt: now })
      .where(
        and(eq(skillRuns.orgId, orgId), eq(skillRuns.id, runId), eq(skillRuns.status, 'queued')),
      )
      .returning({ id: skillRuns.id }),
  );
  return rows.length > 0;
}

/**
 * Stores a running run's outcome (a code, never an error message). False when the run is no
 * longer running (e.g. closed as `interrupted` meanwhile): a late outcome never overwrites it.
 */
export async function finishRun(
  db: Db,
  orgId: string,
  runId: string,
  now: Date,
  outcome: {
    status: 'succeeded' | 'failed' | 'skipped';
    resultCode?: string | null;
    output?: string | null;
    deliveries?: Record<string, string>;
  },
): Promise<boolean> {
  if (!isUuid(runId)) return false;
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .update(skillRuns)
      .set({
        status: outcome.status,
        resultCode: outcome.resultCode ?? null,
        output: outcome.output ?? null,
        deliveries: outcome.deliveries ?? {},
        finishedAt: now,
      })
      .where(
        and(eq(skillRuns.orgId, orgId), eq(skillRuns.id, runId), eq(skillRuns.status, 'running')),
      )
      .returning({ id: skillRuns.id }),
  );
  return rows.length > 0;
}

/**
 * Closes runs a crashed worker left behind: queued for `STALE_RUN_MINUTES` since they were
 * recorded, or running for that long since they were claimed (a run re-sent and claimed late is
 * timed from its claim).
 */
export async function closeStaleRuns(db: Db, orgId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .update(skillRuns)
      .set({ status: 'failed', resultCode: 'interrupted', finishedAt: now })
      .where(
        and(
          eq(skillRuns.orgId, orgId),
          or(
            and(eq(skillRuns.status, 'queued'), lt(skillRuns.createdAt, cutoff)),
            and(
              eq(skillRuns.status, 'running'),
              sql`coalesce(${skillRuns.startedAt}, ${skillRuns.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
            ),
          ),
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
