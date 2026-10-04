import { describe, expect, it } from 'vitest';
import { kanbanLayout, scrumLayout } from './layouts';
import { METRIC_KEYS, parseWidgets, widgetSpecSchema } from './widget-spec';

describe('widget specs', () => {
  it('fills parameter defaults', () => {
    expect(widgetSpecSchema.parse({ id: 'v', metric: 'velocity', chart: 'bar' })).toEqual({
      id: 'v',
      metric: 'velocity',
      chart: 'bar',
      params: { sprints: 6, unit: 'points' },
    });
    expect(
      widgetSpecSchema.parse({
        id: 'c',
        metric: 'cycle_time',
        chart: 'table',
        params: { percentile: 95 },
      }),
    ).toMatchObject({ params: { windowDays: 90, percentile: 95 } });
  });

  it.each([
    ['an unknown metric', { id: 'x', metric: 'sql', chart: 'kpi' }],
    ['a chart the metric does not support', { id: 'x', metric: 'velocity', chart: 'kpi' }],
    [
      'an out-of-range parameter',
      { id: 'x', metric: 'velocity', chart: 'bar', params: { sprints: 1000 } },
    ],
    [
      'a percentile outside 50/85/95',
      { id: 'x', metric: 'cycle_time', chart: 'kpi', params: { percentile: 99 } },
    ],
    [
      'a window beyond a year',
      { id: 'x', metric: 'cycle_time', chart: 'kpi', params: { windowDays: 366 } },
    ],
    ['a zero-day window', { id: 'x', metric: 'cfd', chart: 'area', params: { days: 0 } }],
    [
      'a forecast horizon beyond a year',
      { id: 'x', metric: 'forecast_how_many', chart: 'table', params: { days: 366 } },
    ],
    [
      'a non-integer parameter',
      { id: 'x', metric: 'throughput', chart: 'bar', params: { weeks: 1.5 } },
    ],
    ['an id with spaces', { id: 'a b', metric: 'wip', chart: 'kpi' }],
    ['an id with markup', { id: '<x>', metric: 'wip', chart: 'kpi' }],
    [
      'a title with a control character',
      { id: 'x', metric: 'wip', chart: 'kpi', title: 'a\u0007b' },
    ],
    ['a title with a bidi override', { id: 'x', metric: 'wip', chart: 'kpi', title: 'a\u202Eb' }],
    ['a missing id', { metric: 'wip', chart: 'kpi' }],
    ['an overlong title', { id: 'x', metric: 'wip', chart: 'kpi', title: 'x'.repeat(81) }],
  ])('rejects %s', (_case, input) => {
    expect(widgetSpecSchema.safeParse(input).success).toBe(false);
  });

  it('drops unknown keys instead of storing them', () => {
    const parsed = widgetSpecSchema.parse({
      id: 'w',
      metric: 'wip',
      chart: 'kpi',
      render: '<script>alert(1)</script>',
    });
    expect(parsed).toEqual({ id: 'w', metric: 'wip', chart: 'kpi', params: {} });
  });

  it('skips stored widgets that no longer validate', () => {
    expect(
      parseWidgets([{ id: 'a', metric: 'wip', chart: 'kpi' }, { id: 'b', metric: 'gone' }, 'junk']),
    ).toHaveLength(1);
    expect(parseWidgets(null)).toEqual([]);
  });

  it('default layouts are valid and use every metric of the catalog at most once', () => {
    const all = [...scrumLayout(), ...kanbanLayout()];
    expect(all.every((w) => widgetSpecSchema.safeParse(w).success)).toBe(true);
    for (const layout of [scrumLayout(), kanbanLayout()]) {
      expect(new Set(layout.map((w) => w.id)).size).toBe(layout.length);
    }
    expect(METRIC_KEYS).toHaveLength(19);
  });
});
