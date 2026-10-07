import {
  addDays,
  agingWip,
  type BoardDataset,
  type BurnRow,
  carryOver,
  cumulativeFlow,
  currentSprint,
  cycleTime,
  dailyThroughputSamples,
  flowEfficiency,
  forecastHowMany,
  forecastWhen,
  hygiene,
  isoDay,
  lastClosedSprint,
  leadTime,
  type MetricSprint,
  scopeChange,
  sprintBurn,
  sprintVelocity,
  startOfUtcDay,
  throughputPerWeek,
  type Unit,
  velocity,
  velocitySummary,
  weeklyThroughput,
  wipNow,
  wipSeries,
} from '@agile/metrics';
import type { SprintScope } from './sprint-scope';
import type { WidgetData } from './widget-data';
import type { WidgetSpec } from './widget-spec';

/** Fixed seed: the same data always gives the same forecast (no flicker between page loads). */
export const FORECAST_SEED = 42;

/** Upper bound of the simulated days for "when" forecasts (metrics' default). */
const FORECAST_MAX_DAYS = 730;

const empty = (reason: Extract<WidgetData, { kind: 'empty' }>['reason']): WidgetData => ({
  kind: 'empty',
  reason,
});

const CONFIDENCE = [50, 85, 95] as const;

/** Points need an estimation field; boards that estimate by issue count fall back to issues. */
const unitFor = (ds: BoardDataset, unit: Unit): Unit => (ds.hasEstimates ? unit : 'issues');

const pickSprint = (
  ds: BoardDataset,
  which: 'current' | 'last_closed',
): MetricSprint | undefined => (which === 'current' ? currentSprint(ds) : lastClosedSprint(ds));

/** Evaluates one widget against a board's data. Pure and deterministic for a given `now`. */
export function computeWidget(
  spec: WidgetSpec,
  ds: BoardDataset,
  now: Date,
  scope?: SprintScope,
): WidgetData {
  if (scope && scope.sprints.length > 0) {
    const scoped = computeScoped(spec, ds, now, scope.sprints);
    if (scoped) return scoped;
  }
  switch (spec.metric) {
    case 'average_velocity':
    case 'say_do_ratio': {
      const unit = unitFor(ds, spec.params.unit);
      const rows = velocity(ds, { sprints: spec.params.sprints, unit });
      if (rows.length === 0) return empty('no_sprint');
      const summary = velocitySummary(rows);
      return spec.metric === 'average_velocity'
        ? {
            kind: 'kpi',
            value: summary.average,
            format: unit,
            hint: { key: 'lastSprints', values: { count: rows.length } },
          }
        : {
            kind: 'kpi',
            value: summary.sayDoRatio,
            format: 'percent',
            hint: { key: 'lastSprints', values: { count: rows.length } },
          };
    }
    case 'velocity': {
      const rows = velocity(ds, {
        sprints: spec.params.sprints,
        unit: unitFor(ds, spec.params.unit),
      });
      if (rows.length === 0) return empty('no_sprint');
      return {
        kind: 'series',
        chart: 'bar',
        x: 'sprint',
        series: [{ key: 'committed' }, { key: 'completed' }],
        rows: rows.map((r) => ({ sprint: r.name, committed: r.committed, completed: r.completed })),
      };
    }
    case 'scope_change': {
      const sprint = pickSprint(ds, spec.params.sprint);
      const unit = unitFor(ds, spec.params.unit);
      const change = sprint ? scopeChange(ds, sprint, { unit, now }) : null;
      if (!sprint || !change) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: change.added,
        format: unit,
        hint: { key: 'scopeRemoved', values: { removed: change.removed, sprint: sprint.name } },
      };
    }
    case 'carry_over': {
      const sprint = lastClosedSprint(ds);
      const result = sprint ? carryOver(ds, sprint) : null;
      if (!sprint || !result) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: result.count,
        format: 'issues',
        hint: { key: 'carriedFrom', values: { sprint: sprint.name } },
      };
    }
    case 'sprint_burndown':
    case 'sprint_burnup': {
      const sprint = pickSprint(ds, spec.params.sprint);
      if (!sprint) return empty('no_sprint');
      return burnFor(spec.metric, ds, sprint, unitFor(ds, spec.params.unit), now);
    }
    case 'cycle_time':
    case 'lead_time': {
      const opts = { windowDays: spec.params.windowDays, now };
      const stats = spec.metric === 'cycle_time' ? cycleTime(ds, opts) : leadTime(ds, opts);
      if (stats.count === 0) return empty('no_data');
      if (spec.chart === 'kpi') {
        return {
          kind: 'kpi',
          value: stats[`p${spec.params.percentile}`],
          format: 'days',
          hint: { key: 'finishedIn', values: { count: stats.count, days: spec.params.windowDays } },
        };
      }
      return {
        kind: 'table',
        columns: [
          { key: 'percentile', type: 'text' },
          { key: 'days', type: 'days' },
        ],
        rows: CONFIDENCE.map((p) => [`${p}%`, stats[`p${p}`]]),
      };
    }
    case 'throughput': {
      const rows = weeklyThroughput(ds, { weeks: spec.params.weeks, now });
      return {
        kind: 'series',
        chart: 'bar',
        x: 'week',
        series: [{ key: 'done' }],
        rows: rows.map((r) => ({ week: r.weekStart, done: r.count })),
      };
    }
    case 'throughput_rate':
      return {
        kind: 'kpi',
        value: throughputPerWeek(ds, { days: spec.params.days, now }),
        format: 'per_week',
        hint: { key: 'lastDays', values: { days: spec.params.days } },
      };
    case 'wip':
      return { kind: 'kpi', value: wipNow(ds), format: 'issues' };
    case 'wip_trend':
      return {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: [{ key: 'wip' }],
        rows: wipSeries(ds, { days: spec.params.days, now }).map((r) => ({
          day: r.day,
          wip: r.wip,
        })),
      };
    case 'aging_wip': {
      const items = agingWip(ds, { windowDays: spec.params.windowDays, now });
      if (items.length === 0) return empty('no_data');
      return {
        kind: 'table',
        columns: [
          { key: 'key', type: 'text' },
          { key: 'summary', type: 'text' },
          { key: 'age', type: 'days' },
          { key: 'status', type: 'code' },
        ],
        rows: items.map((i) => [
          i.key,
          i.summary,
          i.ageDays,
          i.blocked ? 'blocked' : i.overP85 ? 'late' : 'on_track',
        ]),
      };
    }
    case 'cfd':
      return {
        kind: 'series',
        chart: 'area',
        x: 'day',
        series: [
          { key: 'done', stacked: true },
          { key: 'inProgress', stacked: true },
          { key: 'todo', stacked: true },
        ],
        rows: cumulativeFlow(ds, { days: spec.params.days, now }),
      };
    case 'flow_efficiency': {
      const result = flowEfficiency(ds, { windowDays: spec.params.windowDays, now });
      if (result.efficiency === null) return empty('no_data');
      return {
        kind: 'kpi',
        value: result.efficiency,
        format: 'percent',
        hint: { key: 'blockedDays', values: { days: Math.round(result.blockedDays) } },
      };
    }
    case 'forecast_how_many': {
      const samples = dailyThroughputSamples(ds, { historyDays: spec.params.historyDays, now });
      const f = forecastHowMany(samples, { days: spec.params.days, seed: FORECAST_SEED });
      if (!f || samples.every((s) => s === 0)) return empty('no_data');
      return {
        kind: 'table',
        columns: [
          { key: 'confidence', type: 'text' },
          { key: 'items', type: 'number' },
        ],
        rows: CONFIDENCE.map((p) => [`${p}%`, f[`p${p}`]]),
      };
    }
    case 'forecast_when': {
      const samples = dailyThroughputSamples(ds, { historyDays: spec.params.historyDays, now });
      const f = forecastWhen(samples, {
        items: spec.params.items,
        seed: FORECAST_SEED,
        maxDays: FORECAST_MAX_DAYS,
      });
      if (!f) return empty('no_data');
      const today = startOfUtcDay(now);
      return {
        kind: 'table',
        columns: [
          { key: 'confidence', type: 'text' },
          { key: 'date', type: 'date' },
        ],
        rows: CONFIDENCE.map((p) => [`${p}%`, isoDay(addDays(today, f[`p${p}`]))]),
        capped: f.capped,
        maxDays: FORECAST_MAX_DAYS,
      };
    }
    case 'hygiene': {
      const findings = hygiene(ds, { now, ...spec.params });
      if (findings.length === 0) return empty('no_data');
      return {
        kind: 'table',
        columns: [
          { key: 'key', type: 'text' },
          { key: 'summary', type: 'text' },
          { key: 'problems', type: 'codes' },
        ],
        rows: findings.map((f) => [f.key, f.summary, f.problems.join(',')]),
      };
    }
  }
}

function burnFor(
  metric: 'sprint_burndown' | 'sprint_burnup',
  ds: BoardDataset,
  sprint: MetricSprint,
  unit: Unit,
  now: Date,
): WidgetData {
  const rows = sprintBurn(ds, sprint, { unit, now });
  if (!rows || rows.length === 0) return empty('no_sprint');
  return metric === 'sprint_burndown'
    ? {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: [{ key: 'remaining' }, { key: 'ideal', dashed: true }],
        rows: rows.map((r) => ({ day: r.day, remaining: r.remaining, ideal: r.ideal })),
      }
    : {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: [{ key: 'scope', dashed: true }, { key: 'completed' }],
        rows: rows.map((r) => ({ day: r.day, scope: r.scope, completed: r.completed })),
      };
}

const ratio = (completed: number, committed: number) =>
  committed > 0 ? Math.round((completed / committed) * 10_000) / 10_000 : null;

/** Several values: each sprint's own, for the KPI card. One value: none. */
const breakdownOf = (items: { label: string; value: number | null }[]) =>
  items.length > 1 ? { breakdown: items } : {};

/** Widgets scoped to the selected sprints (chronological); null: not sprint-scoped here. */
function computeScoped(
  spec: WidgetSpec,
  ds: BoardDataset,
  now: Date,
  sprints: MetricSprint[],
): WidgetData | null {
  switch (spec.metric) {
    case 'average_velocity':
    case 'say_do_ratio': {
      const unit = unitFor(ds, spec.params.unit);
      const rows = sprints
        .filter((s) => s.state === 'closed')
        .flatMap((s) => {
          const row = sprintVelocity(ds, s, { unit, now });
          return row ? [row] : [];
        });
      if (rows.length === 0) return empty('no_sprint');
      const summary = velocitySummary(rows);
      const hint = { key: 'selectedSprints', values: { count: rows.length } };
      return spec.metric === 'average_velocity'
        ? {
            kind: 'kpi',
            value: summary.average,
            format: unit,
            hint,
            ...breakdownOf(rows.map((r) => ({ label: r.name, value: r.completed }))),
          }
        : {
            kind: 'kpi',
            value: summary.sayDoRatio,
            format: 'percent',
            hint,
            ...breakdownOf(
              rows.map((r) => ({ label: r.name, value: ratio(r.completed, r.committed) })),
            ),
          };
    }
    case 'velocity': {
      const unit = unitFor(ds, spec.params.unit);
      const rows = sprints.flatMap((s) => {
        const row = sprintVelocity(ds, s, { unit, now });
        return row ? [row] : [];
      });
      if (rows.length === 0) return empty('no_sprint');
      return {
        kind: 'series',
        chart: 'bar',
        x: 'sprint',
        series: [{ key: 'committed' }, { key: 'completed' }],
        rows: rows.map((r) => ({ sprint: r.name, committed: r.committed, completed: r.completed })),
      };
    }
    case 'scope_change': {
      const unit = unitFor(ds, spec.params.unit);
      const changes = sprints.flatMap((s) => {
        const c = scopeChange(ds, s, { unit, now });
        return c ? [c] : [];
      });
      const last = changes.at(-1);
      if (!last) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: last.added,
        format: unit,
        hint: { key: 'scopeRemoved', values: { removed: last.removed, sprint: last.name } },
        ...breakdownOf(changes.map((c) => ({ label: c.name, value: c.added }))),
      };
    }
    case 'carry_over': {
      const results = sprints.flatMap((s) => {
        const c = carryOver(ds, s);
        return c ? [c] : [];
      });
      const last = results.at(-1);
      if (!last) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: last.count,
        format: 'issues',
        hint: { key: 'carriedFrom', values: { sprint: last.name } },
        ...breakdownOf(results.map((c) => ({ label: c.name, value: c.count }))),
      };
    }
    case 'sprint_burndown':
    case 'sprint_burnup': {
      const unit = unitFor(ds, spec.params.unit);
      const burns = sprints.flatMap((s) => {
        const rows = sprintBurn(ds, s, { unit, now });
        return rows && rows.length > 0 ? [{ sprint: s, rows }] : [];
      });
      const first = burns[0];
      if (!first) return empty('no_sprint');
      if (burns.length === 1) return burnFor(spec.metric, ds, first.sprint, unit, now);
      const value = (r: BurnRow) => (spec.metric === 'sprint_burndown' ? r.remaining : r.completed);
      const days = Math.max(...burns.map((b) => b.rows.length));
      return {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: burns.map((b, i) => ({ key: `s${i}`, label: b.sprint.name })),
        rows: Array.from({ length: days }, (_, day) => ({
          day: `d${day + 1}`,
          ...Object.fromEntries(
            burns.map((b, i) => {
              const row = b.rows[day];
              return [`s${i}`, row ? value(row) : null];
            }),
          ),
        })),
      };
    }
    default:
      return null;
  }
}
