import {
  computeWidget,
  METRIC_KEYS,
  type MetricKey,
  type WidgetData,
  type WidgetSpec,
  widgetSpecSchema,
} from '@agile/dashboards';
import type { BoardDataset } from '@agile/metrics';

/** What each metric means, for list_metrics and explain_metric (English; the model translates). */
export const METRIC_GUIDE: Record<MetricKey, { summary: string; how: string }> = {
  average_velocity: {
    summary: 'Average completed work per sprint over the last closed sprints.',
    how: 'Mean of the work completed in each of the last N closed sprints (story points, or issue count when the board does not estimate).',
  },
  say_do_ratio: {
    summary: 'Share of committed work that was completed (say/do), last closed sprints.',
    how: 'Sum completed ÷ sum committed at sprint start over the last N closed sprints. Work added mid-sprint counts as completed when done.',
  },
  velocity: {
    summary: 'Committed vs completed work per sprint.',
    how: 'Committed = estimates of issues in the sprint at its start; completed = estimates (at close) of issues done when the sprint closed.',
  },
  scope_change: {
    summary: 'Work added to (and removed from) a sprint after it started.',
    how: 'Sum of estimates of issues added after the sprint start; the hint gives the removed amount.',
  },
  carry_over: {
    summary: 'Issues still open when the last sprint closed (carried over).',
    how: 'Count of issues in the last closed sprint that were not done at its completion.',
  },
  sprint_burndown: {
    summary: 'Remaining work per day of a sprint, with the ideal line.',
    how: 'Each UTC day: scope minus completed work, compared with a straight line from start scope to zero.',
  },
  sprint_burnup: {
    summary: 'Completed work and total scope per day of a sprint.',
    how: 'Each UTC day: cumulative completed work and the sprint scope including additions.',
  },
  cycle_time: {
    summary: 'Days from first "in progress" to done, as percentiles.',
    how: 'For issues finished in the window: done time − first in-progress time, in days; nearest-rank percentiles (50/85/95).',
  },
  lead_time: {
    summary: 'Days from creation to done, as percentiles.',
    how: 'For issues finished in the window: done time − creation time, in days; nearest-rank percentiles (50/85/95).',
  },
  throughput: {
    summary: 'Issues finished per week.',
    how: 'Count of issues that reached done in each of the last N weeks (UTC, weeks start Monday).',
  },
  throughput_rate: {
    summary: 'Average issues finished per week, recently.',
    how: 'Issues finished in the last N days × 7 ÷ N.',
  },
  wip: {
    summary: 'Issues in progress right now.',
    how: 'Count of issues whose current status maps to "in progress".',
  },
  wip_trend: {
    summary: 'Work in progress per day.',
    how: 'For each of the last N UTC days, the number of issues in an in-progress status at the end of the day.',
  },
  aging_wip: {
    summary: 'In-progress issues and how long they have been in progress.',
    how: 'Age = now − first in-progress time; "late" when older than the 85th percentile cycle time of the window, "blocked" when flagged or in a waiting status.',
  },
  cfd: {
    summary: 'Cumulative flow: issues to do / in progress / done per day.',
    how: 'For each UTC day, the number of issues in each mapped category at the end of the day.',
  },
  flow_efficiency: {
    summary: 'Share of cycle time spent actively working (not waiting or blocked).',
    how: '(cycle time − waiting/flagged time) ÷ cycle time, summed over issues finished in the window.',
  },
  forecast_how_many: {
    summary: 'Monte Carlo: how many issues will be finished within N days.',
    how: '10,000 simulations sampling past daily throughput (history window); reports the counts reached with 50/85/95% confidence. Fixed seed: same data, same answer.',
  },
  forecast_when: {
    summary: 'Monte Carlo: when N more issues will be finished.',
    how: '10,000 simulations sampling past daily throughput; reports the dates reached with 50/85/95% confidence (capped at 730 days).',
  },
  hygiene: {
    summary:
      'Open issues with data problems: stale, unestimated, unassigned in progress, oversized.',
    how: 'Stale = not updated for N days; oversized = estimate above the threshold; unassigned in progress = in progress without assignee.',
  },
};

const optionFor = (metric: MetricKey) =>
  widgetSpecSchema.options.find((o) => o.shape.metric.value === metric);

/** The richest view of a metric: a table when the catalog allows one (all percentiles), else its chart. */
function chartFor(metric: MetricKey): string {
  const charts = (optionFor(metric)?.shape.chart.options ?? []) as readonly string[];
  return charts.includes('table') ? 'table' : (charts[0] ?? 'kpi');
}

/** Validates params through the widget catalog (same bounds and defaults as dashboards). */
export function metricSpec(
  metric: MetricKey,
  params: Record<string, unknown> | undefined,
): { ok: true; spec: WidgetSpec } | { ok: false; issues: string[] } {
  const parsed = widgetSpecSchema.safeParse({
    id: 'agent',
    metric,
    chart: chartFor(metric),
    params: params ?? {},
  });
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`),
  };
}

export const computeMetric = (spec: WidgetSpec, dataset: BoardDataset, now: Date): WidgetData =>
  computeWidget(spec, dataset, now);

/** Every metric with its summary and default parameters. */
export function metricCatalog() {
  return METRIC_KEYS.map((metric) => {
    const spec = metricSpec(metric, {});
    return {
      metric,
      summary: METRIC_GUIDE[metric].summary,
      defaultParams: spec.ok ? spec.spec.params : {},
    };
  });
}
