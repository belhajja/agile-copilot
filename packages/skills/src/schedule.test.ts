import { describe, expect, it } from 'vitest';
import { checkCron, dueScheduledTime } from './schedule';

describe('schedules', () => {
  it.each([
    ['0 8 * * 1', 'UTC', null],
    ['0 * * * *', 'UTC', null],
    ['30 7 * * 1-5', 'Europe/Paris', null],
    ['*/30 * * * *', 'UTC', 'cron_too_frequent'],
    ['0,30 8 * * *', 'UTC', 'cron_too_frequent'],
    ['* * * * *', 'UTC', 'cron_too_frequent'],
    ['0 8 * *', 'UTC', 'cron_invalid'],
    ['@daily', 'UTC', 'cron_invalid'],
    ['0 25 * * *', 'UTC', 'cron_invalid'],
    ['0 8 * * 1', 'Nowhere/City', 'timezone_invalid'],
    ['', 'UTC', 'cron_invalid'],
    ['   ', 'UTC', 'cron_invalid'],
  ])('checkCron(%s, %s) → %s', (cron, tz, issue) => {
    expect(checkCron(cron, tz)).toBe(issue);
  });

  const mondays8 = { cron: '0 8 * * 1', timezone: 'UTC' };

  it('is due once, right after the scheduled time', () => {
    const at = new Date('2026-10-05T08:00:00Z'); // a Monday
    const saved = new Date('2026-10-01T00:00:00Z');
    expect(dueScheduledTime(mondays8, saved, new Date('2026-10-05T07:59:00Z'))).toBeNull();
    expect(dueScheduledTime(mondays8, saved, at)).toEqual(at);
    expect(dueScheduledTime(mondays8, saved, new Date('2026-10-05T08:04:00Z'))).toEqual(at);
    // Handled: `after` is now the scheduled time itself.
    expect(dueScheduledTime(mondays8, at, new Date('2026-10-05T08:09:00Z'))).toBeNull();
  });

  it('never fires for a time before the skill was saved, nor long after it was missed', () => {
    const at = new Date('2026-10-05T08:00:00Z');
    expect(
      dueScheduledTime(
        mondays8,
        new Date('2026-10-05T08:02:00Z'),
        new Date('2026-10-05T08:05:00Z'),
      ),
    ).toBeNull();
    expect(
      dueScheduledTime(
        mondays8,
        new Date('2026-10-01T00:00:00Z'),
        new Date('2026-10-05T09:01:00Z'),
      ),
    ).toBeNull();
    expect(
      dueScheduledTime(
        mondays8,
        new Date('2026-10-01T00:00:00Z'),
        new Date('2026-10-05T08:59:00Z'),
      ),
    ).toEqual(at);
  });

  it('honours the time zone, across daylight-saving changes', () => {
    const paris = { cron: '0 8 * * *', timezone: 'Europe/Paris' };
    // Summer (UTC+2) and winter (UTC+1): 08:00 in Paris.
    expect(
      dueScheduledTime(paris, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T06:01:00Z')),
    ).toEqual(new Date('2026-07-01T06:00:00Z'));
    expect(
      dueScheduledTime(paris, new Date('2026-12-01T00:00:00Z'), new Date('2026-12-01T07:01:00Z')),
    ).toEqual(new Date('2026-12-01T07:00:00Z'));
  });
});

/** Every run a worker ticking each 5 minutes would start, moving the cursor like the planner. */
function runsOver(
  schedule: { cron: string; timezone: string },
  from: string,
  to: string,
): string[] {
  const runs: string[] = [];
  let cursor = new Date(from);
  for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 5 * 60_000) {
    const due = dueScheduledTime(schedule, cursor, new Date(t));
    if (due) {
      runs.push(due.toISOString());
      cursor = due;
    }
  }
  return runs;
}

describe('daylight-saving transitions (Europe/Paris, 5-minute ticks)', () => {
  const daily = { cron: '30 2 * * *', timezone: 'Europe/Paris' };
  const hourly = { cron: '0 * * * *', timezone: 'Europe/Paris' };

  it('runs a daily 02:30 once on the fall-back day', () => {
    expect(runsOver(daily, '2026-10-24T20:00:00Z', '2026-10-25T20:00:00Z')).toEqual([
      '2026-10-25T00:30:00.000Z',
    ]);
  });

  it('skips a daily 02:30 that does not exist on the spring-forward day', () => {
    expect(runsOver(daily, '2026-03-28T20:00:00Z', '2026-03-29T20:00:00Z')).toEqual([]);
  });

  it('runs an hourly schedule once per local hour on the fall-back day', () => {
    const runs = runsOver(hourly, '2026-10-24T21:30:00Z', '2026-10-25T04:30:00Z');
    expect(runs).toEqual([
      '2026-10-24T22:00:00.000Z',
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T00:00:00.000Z', // 02:00 CEST; 02:00 CET (01:00Z) is the same local time
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
      '2026-10-25T04:00:00.000Z',
    ]);
  });

  it('runs an hourly schedule once per existing local hour on the spring-forward day', () => {
    const runs = runsOver(hourly, '2026-03-28T22:30:00Z', '2026-03-29T03:30:00Z');
    expect(runs).toEqual([
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T01:00:00.000Z', // 03:00 CEST; 02:00 does not exist
      '2026-03-29T02:00:00.000Z',
      '2026-03-29T03:00:00.000Z',
    ]);
  });
});
