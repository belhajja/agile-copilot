export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// Day buckets are UTC calendar days (per-workspace time zones are a later setting).
export const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);

/** yyyy-mm-dd of the UTC day. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Monday 00:00 UTC of the ISO week containing d. */
export const startOfUtcWeek = (d: Date): Date => {
  const day = startOfUtcDay(d);
  return addDays(day, -((day.getUTCDay() + 6) % 7));
};

/** Start of every UTC day from from's day through to's day, inclusive. */
export function eachUtcDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let d = startOfUtcDay(from); d.getTime() <= to.getTime(); d = addDays(d, 1)) days.push(d);
  return days;
}

/** Last instant of the day starting at dayStart, capped at `cap`. */
export const endOfDayCapped = (dayStart: Date, cap: Date): Date =>
  new Date(Math.min(dayStart.getTime() + DAY - 1, cap.getTime()));

export const toDays = (ms: number): number => ms / DAY;
