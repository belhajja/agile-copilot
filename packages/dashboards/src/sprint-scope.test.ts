import type { MetricSprint } from '@agile/metrics';
import { d } from '@agile/metrics/testing';
import { describe, expect, it } from 'vitest';
import {
  bySprintDate,
  MAX_SELECTED_SPRINTS,
  parseSprintSelection,
  selectionPeriod,
} from './sprint-scope';

const sprint = (id: string, over: Partial<MetricSprint> = {}): MetricSprint => ({
  id,
  name: `Sprint ${id}`,
  state: 'closed',
  startAt: d(0),
  endAt: d(10),
  completeAt: d(10),
  members: [],
  ...over,
});

describe('parseSprintSelection', () => {
  const s76 = sprint('76', { startAt: d(0), endAt: d(14), completeAt: d(14) });
  const s77 = sprint('77', { startAt: d(14), endAt: d(28), completeAt: null, state: 'active' });
  const s78 = sprint('78', { startAt: null, endAt: null, completeAt: null, state: 'future' });
  const board = [s78, s77, s76];

  it('no parameter or an empty one means no filter', () => {
    expect(parseSprintSelection(undefined, board)).toEqual([]);
    expect(parseSprintSelection('', board)).toEqual([]);
    expect(parseSprintSelection(' , ', board)).toEqual([]);
  });

  it("keeps only this board's sprints, unique, at most 10", () => {
    expect(parseSprintSelection('77,other-board,77, 76 ', board).map((s) => s.id)).toEqual([
      '76',
      '77',
    ]);
    const many = Array.from({ length: 15 }, (_, i) => sprint(`x${i}`, { startAt: d(i) }));
    const raw = many.map((s) => s.id).join(',');
    expect(parseSprintSelection(raw, many)).toHaveLength(MAX_SELECTED_SPRINTS);
    expect(parseSprintSelection(raw, many)[0]?.id).toBe('x0');
  });

  it('accepts the array form and sorts by date, undated sprints last', () => {
    expect(parseSprintSelection(['78,77', '76'], board).map((s) => s.id)).toEqual([
      '76',
      '77',
      '78',
    ]);
  });
});

describe('bySprintDate', () => {
  it('breaks ties on the start date by name, numbers in order', () => {
    const sprints = [
      sprint('a', { name: 'Sprint 10', startAt: d(0) }),
      sprint('b', { name: 'Sprint 9', startAt: d(0) }),
      sprint('c', { name: 'Sprint 2', startAt: null }),
      sprint('d', { name: 'Sprint 1', startAt: null }),
      sprint('e', { name: 'Sprint 11', startAt: d(-14) }),
    ];
    expect([...sprints].sort(bySprintDate).map((s) => s.name)).toEqual([
      'Sprint 11',
      'Sprint 9',
      'Sprint 10',
      'Sprint 1',
      'Sprint 2',
    ]);
  });
});

describe('selectionPeriod', () => {
  it('spans the earliest start to the latest end, using complete, end, then now', () => {
    const closed = sprint('a', { startAt: d(0), endAt: d(12), completeAt: d(10) });
    const active = sprint('b', { startAt: d(14), endAt: d(28), completeAt: null, state: 'active' });
    expect(selectionPeriod([closed], d(40))).toEqual({ from: d(0), to: d(10) });
    expect(selectionPeriod([closed, active], d(40))).toEqual({ from: d(0), to: d(28) });
    expect(selectionPeriod([closed, active], d(20))).toEqual({ from: d(0), to: d(20) });
  });

  it('a selection without dates has no period', () => {
    const future = sprint('f', { startAt: null, endAt: null, completeAt: null, state: 'future' });
    expect(selectionPeriod([future], d(20))).toBeNull();
    expect(selectionPeriod([], d(20))).toBeNull();
  });
});
