import { z } from 'zod';

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
    id: z.string().min(1).max(64),
    metric: z.literal(metric),
    chart: z.enum(charts),
    /** Optional free-text title; without one the UI shows the metric's translated name. */
    title: z.string().trim().min(1).max(80).optional(),
    params,
  });

export const widgetSpecSchema = z.discriminatedUnion('metric', [
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
]);

export type WidgetSpec = z.infer<typeof widgetSpecSchema>;
export type WidgetSpecInput = z.input<typeof widgetSpecSchema>;
export type MetricKey = WidgetSpec['metric'];
export const METRIC_KEYS: MetricKey[] = widgetSpecSchema.options.map((o) => o.shape.metric.value);

/** Parses stored widgets, dropping (not failing on) any that no longer validate. */
export function parseWidgets(value: unknown): WidgetSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((w) => {
    const parsed = widgetSpecSchema.safeParse(w);
    return parsed.success ? [parsed.data] : [];
  });
}
