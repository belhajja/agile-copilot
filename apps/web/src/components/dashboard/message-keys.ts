/**
 * Dashboard message keys looked up from computed widget data (metric ids, codes, column and
 * series keys from `@agile/dashboards`). Allowlists, never `t.has`: a test ties each list to the
 * messages, in both languages. Anything else is shown as is (or as the generic sentence).
 */

/** `dashboards.metrics.<metric>.title` and `.description`. */
export const DASHBOARD_METRICS = [
  'average_velocity',
  'say_do_ratio',
  'velocity',
  'scope_change',
  'carry_over',
  'sprint_burndown',
  'sprint_burnup',
  'cycle_time',
  'lead_time',
  'throughput',
  'throughput_rate',
  'wip',
  'wip_trend',
  'aging_wip',
  'cfd',
  'flow_efficiency',
  'forecast_how_many',
  'forecast_when',
  'hygiene',
] as const;

/** `dashboards.codes.*`: table cell codes (hygiene problems, forecast confidence). */
export const DASHBOARD_CODES = [
  'blocked',
  'late',
  'on_track',
  'stale',
  'missing_estimate',
  'unassigned_in_progress',
  'oversized',
] as const;

/** `dashboards.columns.*`: table column keys. */
export const DASHBOARD_COLUMNS = [
  'percentile',
  'days',
  'key',
  'summary',
  'age',
  'status',
  'confidence',
  'items',
  'date',
  'problems',
] as const;

/** `dashboards.empty.*`: why a widget has nothing to show. */
export const DASHBOARD_EMPTY_REASONS = ['no_sprint', 'no_data', 'no_estimates'] as const;

/** `dashboards.hints.*`: the line under a KPI value. */
export const DASHBOARD_HINTS = [
  'lastSprints',
  'scopeRemoved',
  'carriedFrom',
  'finishedIn',
  'lastDays',
  'blockedDays',
] as const;

/** `dashboards.series.*`: chart series labels. */
export const DASHBOARD_SERIES = [
  'committed',
  'completed',
  'remaining',
  'ideal',
  'scope',
  'done',
  'wip',
  'todo',
  'inProgress',
] as const;
