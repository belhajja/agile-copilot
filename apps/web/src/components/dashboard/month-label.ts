const MONTH = /^(\d{4})-(\d{2})$/;

/** First day (UTC) of a `yyyy-mm` month bucket of a month dimension; null for anything else. */
export function monthStart(dimension: string, value: string): Date | null {
  if (!dimension.endsWith('Month')) return null;
  const m = MONTH.exec(value);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? new Date(Date.UTC(Number(m[1]), month - 1, 1)) : null;
}

export const MONTH_FORMAT = { month: 'short', year: 'numeric', timeZone: 'UTC' } as const;
