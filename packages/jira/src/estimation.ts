/**
 * Jira's time-tracking fields (values in seconds). A board that "estimates" with one of them has
 * no story points: its metrics count issues instead of showing seconds as points.
 */
const TIME_ESTIMATE_FIELDS = new Set([
  'timeoriginalestimate',
  'timeestimate',
  'aggregatetimeoriginalestimate',
  'aggregatetimeestimate',
]);

/** True when the board's estimation field holds points (story points or another number field). */
export function usesPointEstimates(estimationFieldId: string | null): boolean {
  return estimationFieldId !== null && !TIME_ESTIMATE_FIELDS.has(estimationFieldId.toLowerCase());
}
