import {
  type BoardDataset,
  cycleTime,
  type MetricSprint,
  weeklyThroughput,
  wipSeries,
} from '@agile/metrics';
import { d, scrumFixture } from '@agile/metrics/testing';
import { describe, expect, it } from 'vitest';
import { computeWidget } from './compute';
import { widgetSpecSchema } from './widget-spec';

const NOW = d(40);
const spec = (w: object) => widgetSpecSchema.parse(w);
const ds: BoardDataset = scrumFixture();
const s1 = ds.sprints[0] as MetricSprint;
// A copy of Sprint 1 under another name: same numbers, so every expected value below comes from
// the scrumFixture golden values (velocity 17 committed / 9 completed, scope +1, carry-over 1).
const s2: MetricSprint = { ...s1, id: 's2', name: 'Sprint 2' };
const future: MetricSprint = {
  ...s1,
  id: 's3',
  name: 'Sprint 3',
  state: 'future',
  startAt: null,
  endAt: null,
  completeAt: null,
};
const all: BoardDataset = { ...ds, sprints: [s1, s2, future] };
const scope = (...sprints: MetricSprint[]) => ({ sprints });

describe('computeWidget with a sprint selection', () => {
  it('velocity: one bar pair per selected sprint, future ones skipped', () => {
    const data = computeWidget(
      spec({ id: 'v', metric: 'velocity', chart: 'bar' }),
      all,
      NOW,
      scope(s1, s2, future),
    );
    expect(data).toMatchObject({
      kind: 'series',
      rows: [
        { sprint: 'Sprint 1', committed: 17, completed: 9 },
        { sprint: 'Sprint 2', committed: 17, completed: 9 },
      ],
    });
  });

  it('average velocity over the selection, with a per-sprint breakdown', () => {
    const data = computeWidget(
      spec({ id: 'a', metric: 'average_velocity', chart: 'kpi' }),
      all,
      NOW,
      scope(s1, s2),
    );
    expect(data).toEqual({
      kind: 'kpi',
      value: 9,
      format: 'points',
      hint: { key: 'selectedSprints', values: { count: 2 } },
      breakdown: [
        { label: 'Sprint 1', value: 9 },
        { label: 'Sprint 2', value: 9 },
      ],
    });
  });

  it('one sprint: its own value, no breakdown', () => {
    const data = computeWidget(
      spec({ id: 's', metric: 'say_do_ratio', chart: 'kpi' }),
      all,
      NOW,
      scope(s1),
    );
    expect(data).toEqual({
      kind: 'kpi',
      value: 0.5294,
      format: 'percent',
      hint: { key: 'selectedSprints', values: { count: 1 } },
    });
  });

  it('average velocity leaves active sprints out', () => {
    const active: MetricSprint = { ...s2, state: 'active', completeAt: null };
    const data = computeWidget(
      spec({ id: 'a', metric: 'average_velocity', chart: 'kpi' }),
      { ...ds, sprints: [s1, active] },
      NOW,
      scope(s1, active),
    );
    expect(data).toMatchObject({ kind: 'kpi', value: 9, hint: { values: { count: 1 } } });
  });

  it('scope change and carry-over: the latest sprint, every sprint in the breakdown', () => {
    expect(
      computeWidget(
        spec({ id: 'c', metric: 'scope_change', chart: 'kpi' }),
        all,
        NOW,
        scope(s1, s2),
      ),
    ).toMatchObject({
      kind: 'kpi',
      value: 1,
      hint: { key: 'scopeRemoved', values: { removed: 2, sprint: 'Sprint 2' } },
      breakdown: [
        { label: 'Sprint 1', value: 1 },
        { label: 'Sprint 2', value: 1 },
      ],
    });
    expect(
      computeWidget(spec({ id: 'o', metric: 'carry_over', chart: 'kpi' }), all, NOW, scope(s1)),
    ).toEqual({
      kind: 'kpi',
      value: 1,
      format: 'issues',
      hint: { key: 'carriedFrom', values: { sprint: 'Sprint 1' } },
    });
  });

  it('burndown: the sprint as today for one, one line per sprint by sprint day for several', () => {
    const burn = spec({ id: 'b', metric: 'sprint_burndown', chart: 'line' });
    const single = computeWidget(burn, all, NOW, scope(s1));
    expect(single).toMatchObject({
      kind: 'series',
      x: 'day',
      series: [{ key: 'remaining' }, { key: 'ideal', dashed: true }],
    });
    const several = computeWidget(burn, all, NOW, scope(s1, s2));
    expect(several).toMatchObject({
      kind: 'series',
      chart: 'line',
      x: 'day',
      series: [
        { key: 's0', label: 'Sprint 1' },
        { key: 's1', label: 'Sprint 2' },
      ],
    });
    if (several.kind !== 'series') throw new Error('series');
    // Sprint 1 runs from d0 09:00 to d10 09:00: 11 UTC days, day 1 … day 11.
    expect(several.rows).toHaveLength(11);
    expect(several.rows[0]).toMatchObject({ day: 'd1' });
    expect(several.rows[0]?.s0).toBe(several.rows[0]?.s1);
  });

  it('only future sprints: nothing to show', () => {
    for (const w of [
      { id: 'v', metric: 'velocity', chart: 'bar' },
      { id: 'a', metric: 'average_velocity', chart: 'kpi' },
      { id: 'c', metric: 'scope_change', chart: 'kpi' },
      { id: 'o', metric: 'carry_over', chart: 'kpi' },
      { id: 'b', metric: 'sprint_burnup', chart: 'line' },
    ]) {
      expect(computeWidget(spec(w), all, NOW, scope(future))).toEqual({
        kind: 'empty',
        reason: 'no_sprint',
      });
    }
  });

  it('no selection: the same output as today, for every metric', () => {
    for (const option of widgetSpecSchema.options) {
      for (const chart of option.shape.chart.options) {
        const w = spec({ id: 'x', metric: option.shape.metric.value, chart });
        const today = computeWidget(w, all, NOW);
        expect(computeWidget(w, all, NOW, undefined)).toEqual(today);
        expect(computeWidget(w, all, NOW, { sprints: [] })).toEqual(today);
      }
    }
  });

  it("cycle time over the selected sprint's period", () => {
    // Sprint 1: d0 09:00 → d10 09:00. Done inside: A (d3), E (d6), B (d8).
    const data = computeWidget(
      spec({ id: 'c', metric: 'cycle_time', chart: 'kpi' }),
      all,
      NOW,
      scope(s1),
    );
    const expected = cycleTime(all, { windowDays: 10, now: d(10, 9) });
    expect(expected.count).toBe(3);
    expect(data).toEqual({
      kind: 'kpi',
      value: expected.p85,
      format: 'days',
      hint: { key: 'finishedInSelection', values: { count: 3 } },
    });
  });

  it('uses the whole selection period', () => {
    const late: MetricSprint = {
      ...s1,
      id: 's9',
      name: 'Sprint 9',
      startAt: d(60),
      endAt: d(74),
      completeAt: d(74),
    };
    const wide: BoardDataset = { ...ds, sprints: [s1, late] };
    const data = computeWidget(
      spec({ id: 'w', metric: 'wip_trend', chart: 'line' }),
      wide,
      d(90),
      scope(s1, late),
    );
    if (data.kind !== 'series') throw new Error('series');
    // d0 → d74 inclusive: 75 UTC days, far beyond the widget's own 30.
    expect(data.rows).toHaveLength(75);
    expect(data.rows).toEqual(
      wipSeries(wide, { days: 75, now: d(74) }).map((r) => ({ day: r.day, wip: r.wip })),
    );
    const weeks = computeWidget(
      spec({ id: 't', metric: 'throughput', chart: 'bar' }),
      wide,
      d(90),
      scope(s1, late),
    );
    if (weeks.kind !== 'series') throw new Error('series');
    expect(weeks.rows.map((r) => r.week)).toEqual(
      weeklyThroughput(wide, { weeks: 11, now: d(74) }).map((r) => r.weekStart),
    );
  });

  it('a selection without dates: time-based widgets have no data', () => {
    expect(
      computeWidget(spec({ id: 'c', metric: 'cycle_time', chart: 'kpi' }), all, NOW, scope(future)),
    ).toEqual({
      kind: 'empty',
      reason: 'no_data',
    });
  });

  it('forecasts and current-state widgets are computed as today and flagged', () => {
    for (const w of [
      { id: 'f', metric: 'forecast_how_many', chart: 'table' },
      { id: 'w', metric: 'wip', chart: 'kpi' },
      { id: 'h', metric: 'hygiene', chart: 'table' },
    ]) {
      expect(computeWidget(spec(w), all, NOW, scope(s1))).toEqual({
        ...computeWidget(spec(w), all, NOW),
        unfiltered: true,
      });
    }
  });
});
