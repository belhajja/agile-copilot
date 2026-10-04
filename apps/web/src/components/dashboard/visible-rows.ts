/** Tables show at most this many rows (aging WIP and hygiene can list a whole board). */
export const MAX_TABLE_ROWS = 20;

/** The rows a table shows, and "shown of total" when some were left out. */
export function visibleRows<T>(rows: T[]): {
  rows: T[];
  truncated: { shown: number; total: number } | null;
} {
  if (rows.length <= MAX_TABLE_ROWS) return { rows, truncated: null };
  return {
    rows: rows.slice(0, MAX_TABLE_ROWS),
    truncated: { shown: MAX_TABLE_ROWS, total: rows.length },
  };
}
