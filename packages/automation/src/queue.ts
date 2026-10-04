import { SKILL_RUN_TIMEOUT_MS } from '@agile/agent';
import { recordAudit } from '@agile/connections';
import { type Db, isUuid, organization, skills, withOrg } from '@agile/db';
import { EMAIL_DEADLINE_MS } from '@agile/notify';
import type { SkillActor } from '@agile/skills';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { RunRequestFailureCode, RunSkipCode } from './codes';
import type { AutomationDeps } from './deps';
import { executeSkillRun, type RunOutcome } from './execute';
import { planSkillRuns } from './plan';
import { createRun } from './runs';

export const SKILL_RUN_QUEUE = 'skill-run';
export const SKILL_TICK_QUEUE = 'skills-tick';
/** The scheduler looks for due schedules and alert conditions every 5 minutes. */
export const SKILL_TICK_CRON = '*/5 * * * *';

/**
 * The longest a run can take: the model's deadline plus the slowest delivery (email's overall
 * deadline; a webhook post has 10 s), database work aside. The worker waits at least this long
 * for running runs when it stops.
 */
export const SKILL_RUN_MAX_MS = SKILL_RUN_TIMEOUT_MS + EMAIL_DEADLINE_MS;

/**
 * How long a run job may stay active before pg-boss expires it (and aborts its signal): above the
 * run's 120 s model deadline plus delivery (60 s SMTP deadline, 10 s webhook) and database work,
 * with a wide margin, so a slow but bounded run is never cut short by the queue.
 */
const RUN_JOB_EXPIRE_SECONDS = 600;

/** What a queued job may carry: ids only; the worker re-reads everything under RLS. */
export const skillJobSchema = z
  .object({ orgId: z.string().min(1), runId: z.string().refine(isUuid) })
  .strict();
export type SkillJob = z.infer<typeof skillJobSchema>;

/** Logs the error name only (messages may carry secrets). */
const logErrorName = (error: unknown) =>
  console.error(`[skills] ${error instanceof Error ? error.name : 'UnknownError'}`);

/** Creates both queues (idempotent): the web app sends "Run now" jobs, the worker runs them. */
export async function createSkillQueues(boss: PgBoss): Promise<void> {
  // A run is never retried: each attempt costs a model call, and a failure is shown to the owner.
  // One queued-or-active job per run (singletonKey = run id): re-sending a run is a no-op.
  await boss.createQueue(SKILL_RUN_QUEUE, {
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: RUN_JOB_EXPIRE_SECONDS,
  });
  await boss.createQueue(SKILL_TICK_QUEUE, {
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: 300,
  });
}

// Payloads carry ids only; keyed by run id. `claimRun` still lets only one job run it.
const send = (boss: PgBoss, job: SkillJob) =>
  boss.send(SKILL_RUN_QUEUE, { ...job }, { singletonKey: job.runId });

/**
 * "Run now": the owner runs one of their enabled scheduled or alert skills once, outside its
 * schedule (same read-only run, same delivery, same limits, plus their own "Run now" allowance,
 * P4-R30). Over a limit the run is recorded as skipped and not queued (`skipped` says which).
 */
export async function requestSkillRun(
  deps: { db: Db; boss: PgBoss; dailyLimit: number; now: Date },
  actor: SkillActor,
  skillId: string,
): Promise<
  | { ok: true; runId: string; queued: true; skipped: null }
  | { ok: true; runId: string; queued: false; skipped: RunSkipCode }
  | { ok: false; code: RunRequestFailureCode }
> {
  if (!isUuid(skillId)) return { ok: false, code: 'not_found' };
  const planned = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [skill] = await tx
      .select({
        ownerUserId: skills.ownerUserId,
        visibility: skills.visibility,
        trigger: skills.trigger,
        enabled: skills.enabled,
        version: skills.currentVersion,
      })
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.orgId, actor.orgId)));
    if (!skill || (skill.ownerUserId !== actor.userId && skill.visibility !== 'workspace')) {
      return { ok: false, code: 'not_found' } as const;
    }
    if (skill.ownerUserId !== actor.userId) return { ok: false, code: 'forbidden' } as const;
    if (skill.trigger !== 'schedule' && skill.trigger !== 'alert') {
      return { ok: false, code: 'not_runnable' } as const;
    }
    // It would only be recorded as skipped: turn it on first (M6).
    if (!skill.enabled) return { ok: false, code: 'disabled' } as const;
    const run = await createRun(tx, actor.orgId, {
      skillId,
      version: skill.version,
      trigger: 'manual',
      now: deps.now,
      dailyLimit: deps.dailyLimit,
    });
    if (!run) throw new Error('manual run insert returned nothing');
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'skill.run_requested',
      targetType: 'skill',
      targetId: skillId,
      metadata: { runId: run.id, queued: run.queued },
    });
    // No `skip` was given, so a skipped run was refused by a limit.
    return run.skipped
      ? ({ ok: true, runId: run.id, queued: false, skipped: run.skipped as RunSkipCode } as const)
      : ({ ok: true, runId: run.id, queued: true, skipped: null } as const);
  });
  // Sent after the run row is committed, so the worker always finds it. If the send fails, the
  // run stays queued and the tick re-sends it after RESEND_QUEUED_MINUTES (P4-R19).
  if (planned.ok && planned.queued) {
    await send(deps.boss, { orgId: actor.orgId, runId: planned.runId });
  }
  return planned;
}

/**
 * Scheduler tick: plans every workspace's due runs (and stale queued runs to re-send) and queues
 * them. One failure never starves the others.
 */
export async function enqueueSkillRuns(deps: {
  db: Db;
  boss: PgBoss;
  dailyLimit: number;
  now: Date;
  onError?: (error: unknown) => void;
}): Promise<number> {
  const report = deps.onError ?? logErrorName;
  // `organization` (better-auth) has no org_id column and no RLS: it is the list of tenants.
  const orgs = await deps.db.select({ id: organization.id }).from(organization);
  let sent = 0;
  for (const { id: orgId } of orgs) {
    try {
      const runIds = await planSkillRuns(
        { db: deps.db, dailyLimit: deps.dailyLimit, onError: report },
        orgId,
        deps.now,
      );
      for (const runId of runIds) {
        // null: a job for this run is already queued or active.
        if (await send(deps.boss, { orgId, runId })) sent++;
      }
    } catch (error) {
      report(error);
    }
  }
  return sent;
}

class InvalidSkillJobError extends Error {
  override name = 'InvalidSkillJobError';
  constructor() {
    super('Invalid skill job payload');
  }
}

/** One run job. A malformed payload is reported and dropped. Never throws for a run's outcome. */
export async function handleSkillJob(
  deps: AutomationDeps,
  data: unknown,
  opts: {
    /** The job's own signal (pg-boss aborts it on expiry or stop); combined with deps.signal. */
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
  } = {},
): Promise<RunOutcome | undefined> {
  const parsed = skillJobSchema.safeParse(data);
  if (!parsed.success) {
    (opts.onError ?? logErrorName)(new InvalidSkillJobError());
    return undefined;
  }
  const signals = [deps.signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  return executeSkillRun(deps, parsed.data.orgId, parsed.data.runId, signal);
}

/** Registers the run workers and the scheduler tick on a worker-role pg-boss. */
export async function startSkillWorker(
  boss: PgBoss,
  deps: AutomationDeps,
  opts: {
    concurrency?: number;
    /** Worker shutdown: running runs are aborted (they end as `interrupted`). */
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
    onOutcome?: (job: SkillJob, outcome: RunOutcome) => void;
  } = {},
): Promise<void> {
  await createSkillQueues(boss);
  await boss.work<SkillJob>(
    SKILL_RUN_QUEUE,
    { batchSize: 1, localConcurrency: opts.concurrency ?? 2 },
    async ([job]) => {
      if (!job) return;
      const signals = [opts.signal, job.signal].filter((s): s is AbortSignal => s !== undefined);
      const outcome = await handleSkillJob(deps, job.data, {
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        onError: opts.onError,
      });
      if (outcome) opts.onOutcome?.(job.data, outcome);
    },
  );
  await boss.work(SKILL_TICK_QUEUE, async () => {
    // The tick carries no data; never read it.
    await enqueueSkillRuns({
      db: deps.db,
      boss,
      dailyLimit: deps.dailyLimit,
      now: (deps.now ?? (() => new Date()))(),
      onError: opts.onError,
    });
  });
  await boss.schedule(SKILL_TICK_QUEUE, SKILL_TICK_CRON, null, { tz: 'UTC' });
}
