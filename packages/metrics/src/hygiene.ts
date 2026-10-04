import { currentCategory } from './issue';
import type { BoardDataset } from './model';
import { DAY } from './time';

export type HygieneProblem = 'stale' | 'missing_estimate' | 'unassigned_in_progress' | 'oversized';

export interface HygieneFinding {
  issueId: string;
  key: string;
  summary: string;
  problems: HygieneProblem[];
}

/**
 * Open issues needing attention: not updated for `staleDays`; unestimated on a board that uses
 * estimates; in progress without an assignee; estimated above `oversizedPoints`.
 */
export function hygiene(
  ds: BoardDataset,
  opts: { now: Date; staleDays?: number; oversizedPoints?: number },
): HygieneFinding[] {
  const staleBefore = opts.now.getTime() - (opts.staleDays ?? 14) * DAY;
  const oversized = opts.oversizedPoints ?? 13;
  return ds.issues
    .filter((i) => currentCategory(i) !== 'done')
    .map((i) => {
      const problems: HygieneProblem[] = [];
      if (i.updatedAt.getTime() < staleBefore) problems.push('stale');
      if (ds.hasEstimates && i.estimate === null) problems.push('missing_estimate');
      if (currentCategory(i) === 'in_progress' && i.assignee === null) {
        problems.push('unassigned_in_progress');
      }
      if (i.estimate !== null && i.estimate > oversized) problems.push('oversized');
      return { issueId: i.id, key: i.key, summary: i.summary, problems };
    })
    .filter((f) => f.problems.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}
