import { CronExpressionParser } from 'cron-parser';

/** Scheduled skills run at most once an hour: the model costs money on every run. */
export const MIN_SCHEDULE_MINUTES = 60;

const MINUTE = 60_000;
/** A fixed reference week (Monday 2026-01-05 UTC) to measure the gaps between runs. */
const REFERENCE = new Date('2026-01-05T00:00:00Z');
const SAMPLE = 200;

export type CronIssue = 'cron_invalid' | 'cron_too_frequent' | 'timezone_invalid';

const TIMEZONES = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

/** An IANA time zone name the runtime knows (plus UTC). */
export const isTimeZone = (tz: string) => TIMEZONES.has(tz);

/**
 * Checks a 5-field cron expression (minute hour day-of-month month day-of-week; no seconds, no
 * macros) in a time zone: it must parse, fire at least once a year, and never twice within
 * `MIN_SCHEDULE_MINUTES`.
 */
export function checkCron(cron: string, timezone: string): CronIssue | null {
  if (!isTimeZone(timezone)) return 'timezone_invalid';
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((f) => !/^[\d*,/\-A-Za-z?LW#]+$/.test(f))) {
    return 'cron_invalid';
  }
  try {
    const runs = CronExpressionParser.parse(fields.join(' '), {
      tz: timezone,
      currentDate: REFERENCE,
      strict: false,
    })
      .take(SAMPLE)
      .map((d) => d.getTime());
    if (runs.length === 0 || (runs[0] ?? 0) - REFERENCE.getTime() > 366 * 24 * 60 * MINUTE) {
      return 'cron_invalid';
    }
    for (let i = 1; i < runs.length; i++) {
      if ((runs[i] ?? 0) - (runs[i - 1] ?? 0) < MIN_SCHEDULE_MINUTES * MINUTE) {
        return 'cron_too_frequent';
      }
    }
    return null;
  } catch {
    return 'cron_invalid';
  }
}

/** How late a run may start after its scheduled time (worker down, queue busy) before it is skipped. */
export const MISSED_RUN_GRACE_MINUTES = 60;

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

/** The local date and time (to the minute) of an instant in a time zone, e.g. `2026-10-25 02:30`. */
function wallClock(date: Date, timezone: string): string {
  let format = wallClockFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    wallClockFormats.set(timezone, format);
  }
  return format.format(date);
}

/**
 * The scheduled time a skill should run for now, or null. Pure. `after` is the later of the last
 * scheduled time already handled and the moment the schedule was saved, so saving a skill never
 * fires a run for a time before it existed, and each scheduled time runs once. A time older than
 * the grace period is skipped (no burst of catch-up runs after an outage).
 *
 * Each LOCAL wall-clock occurrence runs at most once: when clocks go back, the repeated local time
 * (e.g. 02:30 happening at 00:30Z and again at 01:30Z) equals the cursor's local time and is
 * skipped. When clocks go forward, a local time that does not exist (02:30 on the spring-forward
 * day) never occurs, so that day's run is skipped.
 */
export function dueScheduledTime(
  schedule: { cron: string; timezone: string },
  after: Date,
  now: Date,
): Date | null {
  let previous: Date;
  try {
    previous = CronExpressionParser.parse(schedule.cron, {
      tz: schedule.timezone,
      currentDate: new Date(now.getTime() + 1),
    })
      .prev()
      .toDate();
  } catch {
    return null;
  }
  if (previous.getTime() <= after.getTime()) return null;
  if (wallClock(previous, schedule.timezone) === wallClock(after, schedule.timezone)) return null;
  if (now.getTime() - previous.getTime() > MISSED_RUN_GRACE_MINUTES * MINUTE) return null;
  return previous;
}
