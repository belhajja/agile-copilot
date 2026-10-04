import {
  type BoardDataset,
  currentCategory,
  currentSprint,
  cycleStart,
  DAY,
  lastClosedSprint,
  type MetricIssue,
  type MetricSprint,
} from '@agile/metrics';
import { z } from 'zod';

/** find_issues filters: parameterised, validated, combined with AND. No query language. */
export const findIssuesInput = {
  boardId: z.string().describe('Board id from list_boards'),
  status: z
    .array(z.enum(['todo', 'in_progress', 'done']))
    .max(3)
    .optional()
    .describe('Workflow categories to keep'),
  type: z.string().trim().min(1).max(64).optional().describe('Issue type name, e.g. Bug'),
  assignee: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe('Assignee name (case-insensitive); "none" for unassigned'),
  text: z.string().trim().min(2).max(100).optional().describe('Words in the key or summary'),
  sprint: z.enum(['current', 'last_closed']).optional().describe('Only issues of this sprint'),
  flagged: z.boolean().optional().describe('Only issues flagged now'),
  staleDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Only issues not updated for at least this many days'),
  sort: z.enum(['updated', 'age', 'key']).default('updated'),
  limit: z.number().int().min(1).max(50).default(20),
};
const schema = z.object(findIssuesInput);
export type FindIssuesInput = z.output<typeof schema>;

const membersAt = (sprint: MetricSprint, at: Date) =>
  new Set(
    sprint.members
      .filter(
        (m) =>
          m.addedAt.getTime() <= at.getTime() &&
          (m.removedAt === null || m.removedAt.getTime() > at.getTime()),
      )
      .map((m) => m.issueId),
  );

const flaggedNow = (i: MetricIssue) => i.flagged.some((f) => f.to === null);

/** Filters a board's synced issues. Pure: the dataset was loaded inside the caller's tenant. */
export function findIssues(ds: BoardDataset, input: FindIssuesInput, now: Date) {
  let sprintIds: Set<string> | null = null;
  if (input.sprint) {
    const sprint = input.sprint === 'current' ? currentSprint(ds) : lastClosedSprint(ds);
    const at = input.sprint === 'current' ? now : (sprint?.completeAt ?? sprint?.endAt ?? now);
    sprintIds = sprint ? membersAt(sprint, at) : new Set();
  }
  const assignee = input.assignee?.toLowerCase();
  const text = input.text?.toLowerCase();
  const staleBefore = input.staleDays ? now.getTime() - input.staleDays * DAY : null;

  const matching = ds.issues.filter(
    (i) =>
      (!input.status || input.status.includes(currentCategory(i))) &&
      (!input.type || i.type.toLowerCase() === input.type.toLowerCase()) &&
      (!assignee ||
        (assignee === 'none' ? i.assignee === null : i.assignee?.toLowerCase() === assignee)) &&
      (!text || `${i.key} ${i.summary}`.toLowerCase().includes(text)) &&
      (!sprintIds || sprintIds.has(i.id)) &&
      (input.flagged === undefined || flaggedNow(i) === input.flagged) &&
      (staleBefore === null || i.updatedAt.getTime() < staleBefore),
  );
  const ageDays = (i: MetricIssue) => {
    const start = cycleStart(i);
    return start && currentCategory(i) === 'in_progress'
      ? Math.round(((now.getTime() - start.getTime()) / DAY) * 10) / 10
      : null;
  };
  const sorted = [...matching].sort((a, b) => {
    if (input.sort === 'key') return a.key.localeCompare(b.key, 'en', { numeric: true });
    if (input.sort === 'age') return (ageDays(b) ?? -1) - (ageDays(a) ?? -1);
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  return {
    total: matching.length,
    issues: sorted.slice(0, input.limit).map((i) => ({
      key: i.key,
      summary: i.summary,
      type: i.type,
      status: currentCategory(i),
      assignee: i.assignee,
      estimate: i.estimate,
      updated: i.updatedAt.toISOString(),
      inProgressDays: ageDays(i),
      flagged: flaggedNow(i),
    })),
  };
}
