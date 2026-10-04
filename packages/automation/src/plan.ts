import { recordAudit } from '@agile/connections';
import { computeWidget, loadBoardDataset } from '@agile/dashboards';
import { type Db, jiraBoards, member, skills, type Tx, withOrg } from '@agile/db';
import type { BoardDataset } from '@agile/metrics';
import {
  alertMatches,
  alertWidget,
  dueScheduledTime,
  loadSkillsWithDocuments,
  type SkillDocument,
} from '@agile/skills';
import { and, eq, inArray } from 'drizzle-orm';
import { closeStaleRuns, createRun, queuedRunsToResend } from './runs';

/** After an alert fires, it does not fire again for this long (flapping metrics). */
export const ALERT_COOLDOWN_HOURS = 12;

export interface PlanDeps {
  db: Db;
  dailyLimit: number;
  /** Required: a skill that fails to plan is skipped, never silently (log its code and name). */
  onError: (error: unknown) => void;
}

type Candidate = {
  id: string;
  name: string;
  ownerUserId: string;
  version: number;
  createdAt: Date;
  scheduleCursor: Date | null;
  skill: SkillDocument;
};

/**
 * Enabled scheduled and alert skills of one workspace, with their parsed current version (one
 * joined query), and the owners among them who are still members of the workspace.
 */
async function candidates(db: Db, orgId: string) {
  return withOrg(db, orgId, async (tx) => {
    const loaded = await loadSkillsWithDocuments(
      tx,
      and(
        eq(skills.orgId, orgId),
        eq(skills.enabled, true),
        inArray(skills.trigger, ['schedule', 'alert']),
      ),
    );
    const list: Candidate[] = [];
    for (const { skill: r, parsed } of loaded) {
      if (!parsed.ok) continue;
      list.push({
        id: r.id,
        name: r.name,
        ownerUserId: r.ownerUserId,
        version: r.currentVersion,
        createdAt: r.createdAt,
        scheduleCursor: r.scheduleCursor,
        skill: parsed.skill,
      });
    }
    const owners = [...new Set(list.map((c) => c.ownerUserId))];
    const members =
      owners.length === 0
        ? []
        : await tx
            .select({ userId: member.userId })
            .from(member)
            .where(and(eq(member.organizationId, orgId), inArray(member.userId, owners)));
    return { list, members: new Set(members.map((m) => m.userId)) };
  });
}

/**
 * Locks the skill row for this plan and returns its edge state as of now, or null when the skill
 * changed since it was loaded (disabled, edited, deleted): the next tick plans it afresh.
 * Concurrent ticks queue on this lock, so each sees what the previous one wrote (P4-R2).
 */
async function lockCandidate(tx: Tx, orgId: string, c: Candidate) {
  const [row] = await tx
    .select({
      enabled: skills.enabled,
      version: skills.currentVersion,
      trigger: skills.trigger,
      scheduleCursor: skills.scheduleCursor,
      alertBoards: skills.alertBoards,
      alertFiredAt: skills.alertFiredAt,
    })
    .from(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.id, c.id)))
    .for('update');
  if (!row?.enabled || row.version !== c.version) return null;
  if (row.trigger !== c.skill.frontmatter.trigger) return null;
  return row;
}

/**
 * A skill whose owner left the workspace: it is disabled (with a skipped `owner_left` run so the
 * reason shows, and an audit entry) instead of being planned on every tick. Once: a disabled
 * skill is no longer a candidate.
 */
async function retireOrphan(deps: PlanDeps, orgId: string, c: Candidate, now: Date) {
  await withOrg(deps.db, orgId, async (tx) => {
    if (!(await lockCandidate(tx, orgId, c))) return;
    await createRun(tx, orgId, {
      skillId: c.id,
      version: c.version,
      trigger: c.skill.frontmatter.trigger === 'alert' ? 'alert' : 'schedule',
      now,
      dailyLimit: deps.dailyLimit,
      skip: 'owner_left',
    });
    await tx.update(skills).set({ enabled: false }).where(eq(skills.id, c.id));
    await recordAudit(tx, {
      orgId,
      actorUserId: null,
      action: 'skill.enabled_changed',
      targetType: 'skill',
      targetId: c.id,
      metadata: { name: c.name, enabled: false, reason: 'owner_left' },
    });
  });
}

/** A scheduled skill: one run per scheduled time, never for times before it was saved. */
async function planSchedule(deps: PlanDeps, orgId: string, c: Candidate, now: Date) {
  const schedule = c.skill.frontmatter.schedule;
  if (!schedule) return null;
  if (!dueScheduledTime(schedule, c.scheduleCursor ?? c.createdAt, now)) return null;
  return withOrg(deps.db, orgId, async (tx) => {
    const row = await lockCandidate(tx, orgId, c);
    if (!row) return null;
    // Re-read under the lock: another tick may have handled this time meanwhile.
    const due = dueScheduledTime(schedule, row.scheduleCursor ?? c.createdAt, now);
    if (!due) return null;
    const run = await createRun(tx, orgId, {
      skillId: c.id,
      version: c.version,
      trigger: 'schedule',
      scheduledFor: due,
      now,
      dailyLimit: deps.dailyLimit,
    });
    // The cursor moves even when the run is refused (daily limit): no catch-up burst later.
    await tx.update(skills).set({ scheduleCursor: due }).where(eq(skills.id, c.id));
    return run?.queued ? run.id : null;
  });
}

/**
 * An alert skill: its condition is evaluated deterministically on each board in scope (no model
 * call). The skill runs when a board starts matching, not while it keeps matching, and at most
 * once per cooldown. Only boards that fired are remembered as alerted (P4-R10 L21): a board that
 * starts matching during the cooldown still fires once the cooldown is over.
 */
async function planAlert(
  deps: PlanDeps,
  orgId: string,
  c: Candidate,
  now: Date,
  boards: { id: string; name: string }[],
  dataset: (boardId: string) => Promise<BoardDataset | null>,
) {
  const alert = c.skill.frontmatter.alert;
  const spec = alert ? alertWidget(alert) : null;
  if (!alert || !spec) return null;
  const scope = c.skill.frontmatter.scope?.boards;
  const matching: { boardId: string; board: string; value: number }[] = [];
  for (const b of boards.filter((b) => !scope || scope.includes(b.id))) {
    const ds = await dataset(b.id);
    if (!ds) continue;
    const data = computeWidget(spec, ds, now);
    const value = data.kind === 'kpi' ? data.value : null;
    if (value !== null && alertMatches(alert.op, value, alert.value)) {
      matching.push({ boardId: b.id, board: b.name, value });
    }
  }
  const matchingIds = new Set(matching.map((m) => m.boardId));
  return withOrg(deps.db, orgId, async (tx) => {
    // The edge state is read under the row lock, so two ticks never both see a board as new.
    const row = await lockCandidate(tx, orgId, c);
    if (!row) return null;
    const fresh = matching.filter((m) => !row.alertBoards.includes(m.boardId));
    const cooled =
      !row.alertFiredAt ||
      now.getTime() - row.alertFiredAt.getTime() >= ALERT_COOLDOWN_HOURS * 3_600_000;
    let runId: string | null = null;
    let fired: string[] = [];
    if (fresh.length > 0 && cooled) {
      const run = await createRun(tx, orgId, {
        skillId: c.id,
        version: c.version,
        trigger: 'alert',
        context: {
          condition: { metric: alert.metric, op: alert.op, value: alert.value },
          matches: fresh,
        },
        now,
        dailyLimit: deps.dailyLimit,
      });
      if (run) {
        fired = fresh.map((m) => m.boardId);
        runId = run.queued ? run.id : null;
      }
    }
    // Boards that stopped matching are forgotten; boards that fired are added; others wait.
    const alertBoards = [...row.alertBoards.filter((id) => matchingIds.has(id)), ...fired];
    await tx
      .update(skills)
      .set({ alertBoards, ...(fired.length > 0 ? { alertFiredAt: now } : {}) })
      .where(eq(skills.id, c.id));
    return runId;
  });
}

/**
 * One scheduler tick for one workspace: closes lost runs, re-sends runs whose job may have been
 * lost, records the runs that are due (schedules) or triggered (alerts) and returns the ids to
 * queue. Skills whose owner left are disabled instead. Skills that fail to plan are reported
 * (`deps.onError`) and skipped; the others still run.
 */
export async function planSkillRuns(deps: PlanDeps, orgId: string, now: Date): Promise<string[]> {
  await closeStaleRuns(deps.db, orgId, now);
  const queued = await queuedRunsToResend(deps.db, orgId, now);
  const { list, members } = await candidates(deps.db, orgId);
  if (list.length === 0) return queued;
  const boards = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({ id: jiraBoards.id, name: jiraBoards.name })
      .from(jiraBoards)
      .where(and(eq(jiraBoards.orgId, orgId), eq(jiraBoards.selected, true))),
  );
  const datasets = new Map<string, Promise<BoardDataset | null>>();
  const dataset = (boardId: string) => {
    let ds = datasets.get(boardId);
    if (!ds) {
      ds = loadBoardDataset(deps.db, orgId, boardId);
      datasets.set(boardId, ds);
    }
    return ds;
  };
  for (const c of list) {
    try {
      if (!members.has(c.ownerUserId)) {
        await retireOrphan(deps, orgId, c, now);
        continue;
      }
      const id =
        c.skill.frontmatter.trigger === 'schedule'
          ? await planSchedule(deps, orgId, c, now)
          : await planAlert(deps, orgId, c, now, boards, dataset);
      if (id) queued.push(id);
    } catch (error) {
      deps.onError(error);
    }
  }
  return queued;
}
