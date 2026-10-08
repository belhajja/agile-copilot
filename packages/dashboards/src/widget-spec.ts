import { z } from 'zod';
import { boardQuerySchema, DISPLAYS } from './query/schema';

// The fixed widget catalog. A widget is data, never code: { metric, params, chart, title }. Phase 4's
// agent creates widgets by emitting these specs, which are validated here before they are stored.

const unit = z.enum(['points', 'issues']).default('points');
const windowDays = z.number().int().min(1).max(365).default(90);
const sprintPick = z.enum(['current', 'last_closed']).default('current');
const percentile = z.union([z.literal(50), z.literal(85), z.literal(95)]).default(85);
const days = (fallback: number) => z.number().int().min(1).max(365).default(fallback);

// `.prefault({})`: a missing params object is parsed as {} so every field default applies.
const p = {
  sprints: z.object({ sprints: z.number().int().min(1).max(20).default(6), unit }).prefault({}),
  sprint: z.object({ sprint: sprintPick, unit }).prefault({}),
  none: z.object({}).prefault({}),
  percentile: z.object({ windowDays, percentile }).prefault({}),
  window: z.object({ windowDays }).prefault({}),
  weeks: z.object({ weeks: z.number().int().min(1).max(52).default(12) }).prefault({}),
  rate: z.object({ days: days(28) }).prefault({}),
  trend: z.object({ days: days(30) }).prefault({}),
  howMany: z
    .object({ days: z.number().int().min(1).max(365).default(14), historyDays: days(30) })
    .prefault({}),
  when: z
    .object({ items: z.number().int().min(1).max(500).default(10), historyDays: days(30) })
    .prefault({}),
  hygiene: z
    .object({
      staleDays: z.number().int().min(1).max(365).default(14),
      oversizedPoints: z.number().min(1).max(100).default(13),
    })
    .prefault({}),
};

const widget = <M extends string, C extends readonly [string, ...string[]], P extends z.ZodType>(
  metric: M,
  charts: C,
  params: P,
) =>
  z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    metric: z.literal(metric),
    chart: z.enum(charts),
    /** Optional free-text title; without one the UI shows the metric's translated name. */
    title: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((v) => !/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(v))
      .optional(),
    params,
  });

/** What a stored query widget holds once its query no longer validates (shown as unavailable). */
const UNAVAILABLE_QUERY = { unavailable: true } as const;
const storedQuery = z
  .union([boardQuerySchema, z.strictObject({ unavailable: z.literal(true) })])
  .catch(UNAVAILABLE_QUERY);

const catalog = <Q extends z.ZodType>(query: Q) =>
  z.discriminatedUnion('metric', [
    widget('average_velocity', ['kpi'], p.sprints),
    widget('say_do_ratio', ['kpi'], p.sprints),
    widget('velocity', ['bar'], p.sprints),
    widget('scope_change', ['kpi'], p.sprint),
    widget('carry_over', ['kpi'], p.none),
    widget('sprint_burndown', ['line'], p.sprint),
    widget('sprint_burnup', ['line'], p.sprint),
    widget('cycle_time', ['kpi', 'table'], p.percentile),
    widget('lead_time', ['kpi', 'table'], p.percentile),
    widget('throughput', ['bar'], p.weeks),
    widget('throughput_rate', ['kpi'], p.rate),
    widget('wip', ['kpi'], p.none),
    widget('wip_trend', ['line'], p.trend),
    widget('aging_wip', ['table'], p.window),
    widget('cfd', ['area'], p.trend),
    widget('flow_efficiency', ['kpi'], p.window),
    widget('forecast_how_many', ['table'], p.howMany),
    widget('forecast_when', ['table'], p.when),
    widget('hygiene', ['table'], p.hygiene),
    /** A board query from the assistant; its chart is the query's display. */
    widget('query', DISPLAYS, query),
  ]);

/** What the assistant and the Pin button may store: a query must be valid. */
export const widgetSpecSchema = catalog(boardQuerySchema);
/** Stored widgets: a query that no longer validates is kept, marked unavailable. */
const storedWidgetSpecSchema = catalog(storedQuery);

/** A dashboard's widgets: at most 40, unique ids (the UI keys widgets by id). */
export const widgetListSchema = storedWidgetSpecSchema
  .array()
  .max(40)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [index, w] of list.entries()) {
      if (seen.has(w.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'duplicate id' });
      seen.add(w.id);
      if (w.metric === 'query' && !('unavailable' in w.params) && w.chart !== w.params.display) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'chart'],
          message: 'chart must be the query display',
        });
      }
    }
  });

export type WidgetSpec = z.infer<typeof storedWidgetSpecSchema>;
export type WidgetSpecInput = z.input<typeof widgetSpecSchema>;
export type MetricKey = WidgetSpec['metric'];
export const METRIC_KEYS: MetricKey[] = widgetSpecSchema.options.map((o) => o.shape.metric.value);
/** The fixed metrics (everything but assistant queries): what get_metric and list_metrics offer. */
export type CatalogMetricKey = Exclude<MetricKey, 'query'>;
export const CATALOG_METRIC_KEYS: CatalogMetricKey[] = METRIC_KEYS.filter(
  (m): m is CatalogMetricKey => m !== 'query',
);

/** Every chart type a widget can have, across the catalog and query displays. */
export const WIDGET_CHARTS = [
  ...new Set(widgetSpecSchema.options.flatMap((o) => o.shape.chart.options)),
] as WidgetSpec['chart'][];

/**
 * The charts a stored widget can switch to: its metric's charts, or for a query the displays its
 * query is valid with. An unavailable query keeps the one it has.
 */
export function chartOptions(spec: WidgetSpec): WidgetSpec['chart'][] {
  if (spec.metric !== 'query') {
    const option = widgetSpecSchema.options.find((o) => o.shape.metric.value === spec.metric);
    return option ? [...option.shape.chart.options] : [spec.chart];
  }
  const { params } = spec;
  if ('unavailable' in params) return [spec.chart];
  return DISPLAYS.filter(
    (display) =>
      widgetSpecSchema.safeParse({ ...spec, chart: display, params: { ...params, display } })
        .success,
  );
}

/** Parses stored widgets, dropping (not failing on) any that no longer validate. */
export function parseWidgets(value: unknown): WidgetSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((w) => {
    const parsed = storedWidgetSpecSchema.safeParse(w);
    return parsed.success ? [parsed.data] : [];
  });
}
