import type { MetricSprint } from '@agile/metrics';

/** Sprints a dashboard can compare at once. */
export const MAX_SELECTED_SPRINTS = 10;

/** The sprints a dashboard is scoped to (non-empty, chronological). */
export interface SprintScope {
  sprints: MetricSprint[];
}

/** Chronological: start date, sprints never started last, then name. */
export function bySprintDate(a: MetricSprint, b: MetricSprint): number {
  const at = a.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return at - bt || a.name.localeCompare(b.name, undefined, { numeric: true });
}

/**
 * The `sprints` URL parameter (comma-separated ids, or several values) resolved against the
 * board's sprints: unknown ids (another board's, a typo) are dropped, duplicates too, at most
 * MAX_SELECTED_SPRINTS in URL order. Empty means no filter.
 */
export function parseSprintSelection(
  raw: string | string[] | undefined,
  boardSprints: readonly MetricSprint[],
): MetricSprint[] {
  const byId = new Map(boardSprints.map((s) => [s.id, s]));
  const ids = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap((part) => part.split(','))
    .map((id) => id.trim())
    .filter((id) => byId.has(id));
  return [...new Set(ids)]
    .slice(0, MAX_SELECTED_SPRINTS)
    .flatMap((id) => {
      const s = byId.get(id);
      return s ? [s] : [];
    })
    .sort(bySprintDate);
}

/**
 * From the earliest start to the latest end of the selected sprints (end = complete date, else
 * planned end, else now), capped at now. Sprints never started do not count; none started: null.
 */
export function selectionPeriod(
  sprints: readonly MetricSprint[],
  now: Date,
): { from: Date; to: Date } | null {
  const started = sprints.filter((s): s is MetricSprint & { startAt: Date } => s.startAt !== null);
  if (started.length === 0) return null;
  const from = Math.min(...started.map((s) => s.startAt.getTime()));
  const end = Math.max(...started.map((s) => (s.completeAt ?? s.endAt ?? now).getTime()));
  return { from: new Date(from), to: new Date(Math.min(end, now.getTime())) };
}
