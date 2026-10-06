import { describe, expect, it } from 'vitest';
import {
  EMPTY_TIME_TRACKING,
  hoursFromSeconds,
  parseJiraDuration,
  timeTrackingConfigFrom,
  timeTrackingFromMcp,
  timeTrackingFromRest,
} from './time-tracking';

const EIGHT = { hoursPerDay: 8, daysPerWeek: 5 };

describe('hoursFromSeconds', () => {
  it('converts to hours rounded to 0.1', () => {
    expect(hoursFromSeconds(40_320)).toBe(11.2);
    expect(hoursFromSeconds(0)).toBe(0);
    expect(hoursFromSeconds(1_800)).toBe(0.5);
  });
  it('is null for anything that is not a non-negative number', () => {
    for (const v of [null, undefined, '3600', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hoursFromSeconds(v)).toBeNull();
    }
  });
});

describe('parseJiraDuration', () => {
  it('reads weeks, days, hours and minutes with the instance setting', () => {
    expect(parseJiraDuration('1d 3h 12m', EIGHT)).toBeCloseTo(11.2);
    expect(parseJiraDuration('4d', EIGHT)).toBe(32);
    expect(parseJiraDuration('1w 2d', EIGHT)).toBe(56);
    expect(parseJiraDuration('1d', { hoursPerDay: 7.2, daysPerWeek: 5 })).toBeCloseTo(7.2);
  });
  it('reads hours and minutes without a setting, and decimals', () => {
    expect(parseJiraDuration('3h 30m', null)).toBe(3.5);
    expect(parseJiraDuration('0m', null)).toBe(0);
    expect(parseJiraDuration('1.5h', null)).toBe(1.5);
  });
  it('never guesses: days or weeks without a setting, or unknown text, give null', () => {
    expect(parseJiraDuration('1d', null)).toBeNull();
    expect(parseJiraDuration('1j 3h', EIGHT)).toBeNull();
    expect(parseJiraDuration('soon', EIGHT)).toBeNull();
    expect(parseJiraDuration('', EIGHT)).toBeNull();
    expect(parseJiraDuration(undefined, EIGHT)).toBeNull();
    expect(parseJiraDuration('3h 3h', EIGHT)).toBeNull();
  });
});

describe('timeTrackingConfigFrom', () => {
  it('reads the working-time setting', () => {
    expect(
      timeTrackingConfigFrom({
        timeTrackingEnabled: true,
        timeTrackingConfiguration: { workingHoursPerDay: 8, workingDaysPerWeek: 5 },
      }),
    ).toEqual(EIGHT);
  });
  it('is null when time tracking is off or the values are unusable', () => {
    expect(timeTrackingConfigFrom({ timeTrackingEnabled: false })).toBeNull();
    expect(
      timeTrackingConfigFrom({
        timeTrackingEnabled: true,
        timeTrackingConfiguration: { workingHoursPerDay: 0, workingDaysPerWeek: 5 },
      }),
    ).toBeNull();
    expect(timeTrackingConfigFrom('nope')).toBeNull();
  });
});

describe('timeTrackingFromRest', () => {
  it('uses the exact seconds and keeps the text', () => {
    expect(
      timeTrackingFromRest({
        originalEstimate: '1d 3h 12m',
        remainingEstimate: '0m',
        timeSpent: '1d 6h',
        originalEstimateSeconds: 40_320,
        remainingEstimateSeconds: 0,
        timeSpentSeconds: 50_400,
      }),
    ).toEqual({
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateHours: 11.2,
      remainingEstimateHours: 0,
      timeSpentHours: 14,
    });
  });
  it('is all null without time tracking', () => {
    expect(timeTrackingFromRest(undefined)).toEqual(EMPTY_TIME_TRACKING);
    expect(timeTrackingFromRest({})).toEqual(EMPTY_TIME_TRACKING);
  });
});

describe('timeTrackingFromMcp', () => {
  const raw = { original_estimate: '1d 3h 12m', remaining_estimate: '0m', time_spent: '1d 6h' };
  it('parses the text with the setting', () => {
    expect(timeTrackingFromMcp(raw, EIGHT)).toEqual({
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateHours: 11.2,
      remainingEstimateHours: 0,
      timeSpentHours: 14,
    });
  });
  it('keeps the text and gives null hours for day units without the setting', () => {
    expect(timeTrackingFromMcp(raw, null)).toEqual({
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateHours: null,
      remainingEstimateHours: 0,
      timeSpentHours: null,
    });
  });
  it('is all null without time tracking', () => {
    expect(timeTrackingFromMcp(undefined, EIGHT)).toEqual(EMPTY_TIME_TRACKING);
  });
});
