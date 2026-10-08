const HISTORY_GROUPS = ['today', 'yesterday', 'week', 'month', 'older'] as const;
export type HistoryGroup = (typeof HISTORY_GROUPS)[number];

/** Days since the epoch for the calendar day `date` falls on in `timeZone`. */
function dayNumber(date: Date, timeZone: string): number {
  // en-CA formats as YYYY-MM-DD.
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone }).format(date).split('-');
  return Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86_400_000;
}

function groupOf(days: number): HistoryGroup {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'older';
}

/**
 * Splits conversations (newest first) into Today / Yesterday / Previous 7 days / Previous 30 days /
 * Older by calendar day in `timeZone`. Empty groups are left out; order inside a group is kept.
 */
export function groupConversations<T extends { updatedAt: Date }>(
  conversations: readonly T[],
  now: Date,
  timeZone: string,
): { key: HistoryGroup; items: T[] }[] {
  const today = dayNumber(now, timeZone);
  const groups = new Map<HistoryGroup, T[]>();
  for (const c of conversations) {
    const key = groupOf(today - dayNumber(c.updatedAt, timeZone));
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return HISTORY_GROUPS.filter((k) => groups.has(k)).map((key) => ({
    key,
    items: groups.get(key) ?? [],
  }));
}
