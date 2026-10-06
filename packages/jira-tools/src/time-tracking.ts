/**
 * Time tracking in hours. REST gives exact seconds; mcp-atlassian only returns Jira's display text
 * ("1d 3h 12m"), which is parsed with the instance's own working-time setting: a day or a week is
 * never assumed.
 */

export interface TimeTrackingConfig {
  hoursPerDay: number;
  daysPerWeek: number;
}

export interface TimeTracking {
  originalEstimate: string | null;
  remainingEstimate: string | null;
  timeSpent: string | null;
  originalEstimateHours: number | null;
  remainingEstimateHours: number | null;
  timeSpentHours: number | null;
}

export const EMPTY_TIME_TRACKING: TimeTracking = Object.freeze({
  originalEstimate: null,
  remainingEstimate: null,
  timeSpent: null,
  originalEstimateHours: null,
  remainingEstimateHours: null,
  timeSpentHours: null,
});

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const round = (hours: number) => Math.round(hours * 10) / 10;

export function hoursFromSeconds(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds / 360) / 10
    : null;
}

const PART = /^(\d+(?:\.\d+)?)([wdhm])$/;

/** Hours in a Jira duration ("1w 2d 3h 30m"); null for anything it cannot read exactly. */
export function parseJiraDuration(
  value: unknown,
  config: TimeTrackingConfig | null,
): number | null {
  const t = text(value);
  if (!t) return null;
  const seen = new Set<string>();
  let hours = 0;
  for (const part of t.split(/\s+/)) {
    const m = PART.exec(part);
    if (!m) return null;
    const [, amount, unit] = m as unknown as [string, string, 'w' | 'd' | 'h' | 'm'];
    if (seen.has(unit)) return null;
    seen.add(unit);
    const n = Number(amount);
    if (unit === 'm') hours += n / 60;
    else if (unit === 'h') hours += n;
    else if (!config) return null;
    else if (unit === 'd') hours += n * config.hoursPerDay;
    else hours += n * config.hoursPerDay * config.daysPerWeek;
  }
  return hours;
}

/** The working-time setting from `GET /rest/api/2/configuration`; null when unusable. */
export function timeTrackingConfigFrom(raw: unknown): TimeTrackingConfig | null {
  const r = obj(raw);
  if (r.timeTrackingEnabled !== true) return null;
  const c = obj(r.timeTrackingConfiguration);
  const hoursPerDay = c.workingHoursPerDay;
  const daysPerWeek = c.workingDaysPerWeek;
  return typeof hoursPerDay === 'number' &&
    hoursPerDay > 0 &&
    hoursPerDay <= 24 &&
    typeof daysPerWeek === 'number' &&
    daysPerWeek > 0 &&
    daysPerWeek <= 7
    ? { hoursPerDay, daysPerWeek }
    : null;
}

/** Jira REST `fields.timetracking` (exact seconds). */
export function timeTrackingFromRest(raw: unknown): TimeTracking {
  const r = obj(raw);
  return {
    originalEstimate: text(r.originalEstimate),
    remainingEstimate: text(r.remainingEstimate),
    timeSpent: text(r.timeSpent),
    originalEstimateHours: hoursFromSeconds(r.originalEstimateSeconds),
    remainingEstimateHours: hoursFromSeconds(r.remainingEstimateSeconds),
    timeSpentHours: hoursFromSeconds(r.timeSpentSeconds),
  };
}

/** mcp-atlassian's `timetracking` (display text only), parsed with the instance's setting. */
export function timeTrackingFromMcp(raw: unknown, config: TimeTrackingConfig | null): TimeTracking {
  const r = obj(raw);
  const hours = (v: unknown) => {
    const h = parseJiraDuration(v, config);
    return h === null ? null : round(h);
  };
  return {
    originalEstimate: text(r.original_estimate),
    remainingEstimate: text(r.remaining_estimate),
    timeSpent: text(r.time_spent),
    originalEstimateHours: hours(r.original_estimate),
    remainingEstimateHours: hours(r.remaining_estimate),
    timeSpentHours: hours(r.time_spent),
  };
}
