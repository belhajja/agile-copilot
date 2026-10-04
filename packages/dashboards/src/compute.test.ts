import type { BoardDataset } from '@agile/metrics';
import { describe, expect, it } from 'vitest';
import { computeWidget } from './compute';
import { widgetSpecSchema } from './widget-spec';

const NOW = new Date('2026-10-04T08:00:00Z');
const spec = (w: object) => widgetSpecSchema.parse(w);
const emptyDs: BoardDataset = { issues: [], sprints: [], hasEstimates: true };

describe('computeWidget on a board without history', () => {
  it('returns empty data instead of throwing', () => {
    for (const w of [
      { id: 'a', metric: 'velocity', chart: 'bar' },
      { id: 'b', metric: 'sprint_burndown', chart: 'line' },
      { id: 'c', metric: 'forecast_when', chart: 'table' },
      { id: 'd', metric: 'forecast_how_many', chart: 'table' },
      { id: 'e', metric: 'cycle_time', chart: 'kpi' },
    ]) {
      expect(computeWidget(spec(w), emptyDs, NOW)).toEqual({
        kind: 'empty',
        reason: w.metric === 'velocity' || w.metric === 'sprint_burndown' ? 'no_sprint' : 'no_data',
      });
    }
  });

  it('gives null/zero KPIs and empty data for the remaining widgets', () => {
    expect(
      computeWidget(spec({ id: 't', metric: 'throughput_rate', chart: 'kpi' }), emptyDs, NOW),
    ).toMatchObject({ kind: 'kpi', value: 0 });
    expect(
      computeWidget(spec({ id: 'w', metric: 'wip', chart: 'kpi' }), emptyDs, NOW),
    ).toMatchObject({
      kind: 'kpi',
      value: 0,
    });
    for (const w of [
      { id: 's', metric: 'scope_change', chart: 'kpi' },
      { id: 'u', metric: 'sprint_burnup', chart: 'line' },
    ]) {
      expect(computeWidget(spec(w), emptyDs, NOW)).toEqual({ kind: 'empty', reason: 'no_sprint' });
    }
    for (const w of [
      { id: 'a', metric: 'aging_wip', chart: 'table' },
      { id: 'h', metric: 'hygiene', chart: 'table' },
      { id: 'f', metric: 'flow_efficiency', chart: 'kpi' },
    ]) {
      expect(computeWidget(spec(w), emptyDs, NOW)).toEqual({ kind: 'empty', reason: 'no_data' });
    }
  });
});
