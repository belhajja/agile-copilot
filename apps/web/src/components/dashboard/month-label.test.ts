import { describe, expect, it } from 'vitest';
import { monthStart } from './month-label';

describe('monthStart', () => {
  it('reads the month buckets of a month dimension', () => {
    expect(monthStart('createdMonth', '2026-09')).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(monthStart('resolvedMonth', '2025-12')).toEqual(new Date('2025-12-01T00:00:00Z'));
  });

  it('leaves other values and dimensions alone', () => {
    expect(monthStart('createdMonth', '@none')).toBeNull();
    expect(monthStart('createdMonth', '2026-13')).toBeNull();
    expect(monthStart('fixVersion', '2026-09')).toBeNull();
    expect(monthStart('createdWeek', '2026-09-07')).toBeNull();
  });
});
