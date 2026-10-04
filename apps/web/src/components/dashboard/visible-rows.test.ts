import { describe, expect, it } from 'vitest';
import { MAX_TABLE_ROWS, visibleRows } from './visible-rows';

describe('visibleRows', () => {
  it('shows the first 20 rows and reports the total when it truncates', () => {
    const rows = Array.from({ length: 27 }, (_, i) => [i]);
    expect(MAX_TABLE_ROWS).toBe(20);
    const v = visibleRows(rows);
    expect(v.rows).toHaveLength(20);
    expect(v.rows[0]).toEqual([0]);
    expect(v.truncated).toEqual({ shown: 20, total: 27 });
  });

  it('reports nothing when every row fits', () => {
    expect(visibleRows([[1], [2]])).toEqual({ rows: [[1], [2]], truncated: null });
    const exactly = Array.from({ length: 20 }, (_, i) => [i]);
    expect(visibleRows(exactly).truncated).toBeNull();
  });
});
