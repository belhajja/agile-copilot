import { z } from 'zod';

// A board query: data the assistant writes and the dashboard re-runs on synced data. Every time
// reference is relative to "now", so a pinned query stays live.

export const DIMENSIONS = [
  'type',
  'status',
  'statusCategory',
  'assignee',
  'label',
  'epic',
  'priority',
  'component',
  'fixVersion',
  'sprint',
  'createdWeek',
  'createdMonth',
  'resolvedWeek',
  'resolvedMonth',
] as const;
export const MEASURES = ['count', 'points', 'avg_cycle_time', 'p85_cycle_time', 'avg_age'] as const;
export const DISPLAYS = ['kpi', 'table', 'bar', 'stacked_bar', 'line', 'pie', 'list'] as const;
export const COLUMNS = [
  'key',
  'summary',
  'type',
  'status',
  'assignee',
  'points',
  'priority',
  'epic',
  'labels',
  'created',
  'resolved',
  'age',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];
export type Measure = (typeof MEASURES)[number];
export type Display = (typeof DISPLAYS)[number];
export type Column = (typeof COLUMNS)[number];

export const TIME_DIMENSIONS: ReadonlySet<Dimension> = new Set<Dimension>([
  'createdWeek',
  'createdMonth',
  'resolvedWeek',
  'resolvedMonth',
]);

/** Largest serialized query (it is stored in the dashboard row and sent to the model). */
export const MAX_QUERY_BYTES = 4096;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\p{Cc}‪-‮⁦-⁩]/u.test(v), 'control characters');
const names = z.array(text(100)).min(1).max(10);

const sprintRef = z.union([
  z.literal('active'),
  z.literal('last_closed'),
  z.strictObject({ lastClosed: z.number().int().min(1).max(20) }),
  z.strictObject({ id: z.string().min(1).max(64) }),
]);
const window = z.union([
  z.strictObject({ lastDays: z.number().int().min(1).max(730) }),
  z.strictObject({ sinceSprintsAgo: z.number().int().min(1).max(20) }),
]);

const filter = z.strictObject({
  types: names.optional(),
  statuses: names.optional(),
  statusCategory: z
    .array(z.enum(['todo', 'in_progress', 'done']))
    .min(1)
    .max(3)
    .optional(),
  /** Display names; null = unassigned. */
  assignees: z.array(text(100).nullable()).min(1).max(10).optional(),
  labels: names.optional(),
  /** Epic keys or names. */
  epics: names.optional(),
  priorities: names.optional(),
  components: names.optional(),
  fixVersions: names.optional(),
  sprints: z.array(sprintRef).min(1).max(10).optional(),
  created: window.optional(),
  resolved: window.optional(),
});

const list = z.strictObject({
  columns: z.array(z.enum(COLUMNS)).min(1).max(8),
  sort: z
    .strictObject({ by: z.enum(COLUMNS), dir: z.enum(['asc', 'desc']).default('asc') })
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const boardQuerySchema = z
  .strictObject({
    title: text(80),
    filter: filter.optional(),
    groupBy: z.array(z.enum(DIMENSIONS)).min(1).max(2).optional(),
    measure: z.enum(MEASURES).default('count'),
    display: z.enum(DISPLAYS),
    list: list.optional(),
    /** Keep the N largest groups; the rest becomes "Other". Categories only. */
    top: z.number().int().min(1).max(20).optional(),
  })
  .superRefine((q, ctx) => {
    const refuse = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const dims = q.groupBy ?? [];
    const [first] = dims;
    if (new Set(dims).size !== dims.length) refuse(['groupBy'], 'the same dimension twice');
    switch (q.display) {
      case 'kpi':
        if (dims.length > 0) refuse(['groupBy'], 'kpi takes no groupBy');
        break;
      case 'list':
        if (dims.length > 0) refuse(['groupBy'], 'list takes no groupBy');
        if (!q.list) refuse(['list'], 'list needs list.columns');
        break;
      case 'table':
        if (dims.length === 0)
          refuse(['groupBy'], 'table needs groupBy (use display list for issues)');
        break;
      case 'stacked_bar':
        if (dims.length !== 2) refuse(['groupBy'], 'stacked_bar needs 2 dimensions');
        break;
      default:
        if (dims.length !== 1) refuse(['groupBy'], `${q.display} needs 1 dimension`);
        else if (
          q.display === 'line' &&
          first !== undefined &&
          !TIME_DIMENSIONS.has(first) &&
          first !== 'sprint'
        ) {
          refuse(['groupBy'], 'line needs a week, month or sprint dimension');
        }
    }
    if (q.list && q.display !== 'list') refuse(['list'], 'list is only for display list');
    if (q.display === 'pie' && q.measure !== 'count' && q.measure !== 'points') {
      refuse(['measure'], 'pie needs count or points');
    }
    if (
      q.top !== undefined &&
      first !== undefined &&
      (TIME_DIMENSIONS.has(first) || first === 'sprint')
    ) {
      refuse(['top'], 'top is for categories');
    }
    if (JSON.stringify(q).length > MAX_QUERY_BYTES) {
      refuse([], `query larger than ${MAX_QUERY_BYTES} bytes`);
    }
  });

export type BoardQuery = z.output<typeof boardQuerySchema>;
export type QueryFilter = NonNullable<BoardQuery['filter']>;
export type SprintRef = NonNullable<QueryFilter['sprints']>[number];
export type QueryWindow = NonNullable<QueryFilter['created']>;
