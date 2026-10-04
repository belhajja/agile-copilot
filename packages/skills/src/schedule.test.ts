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
