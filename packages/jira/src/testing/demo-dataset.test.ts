import { describe, expect, it } from 'vitest';
import { parseJiraDate } from '../issue-normalize';
import { demoDataset } from './demo-dataset';

describe('demo dataset', () => {
  const ds = demoDataset(new Date('2026-10-04T15:30:00Z'));
  const time = (v: unknown) => parseJiraDate(v)?.getTime() ?? Number.NaN;

  it('has a Scrum board with 4 sprints and a Kanban board', () => {
    expect(ds.boards.map((b) => [b.name, b.type, b.filterId])).toEqual([
      ['DEMO Scrum', 'scrum', 101],
      ['OPS Kanban', 'kanban', 102],
    ]);
    expect(ds.sprints.map((s) => [s.name, s.state])).toEqual([
      ['DEMO Sprint 1', 'closed'],
      ['DEMO Sprint 2', 'closed'],
      ['DEMO Sprint 3', 'closed'],
      ['DEMO Sprint 4', 'active'],
    ]);
    expect(ds.issues.filter((i) => i.filterIds.includes(101))).toHaveLength(25);
    expect(ds.issues.filter((i) => i.filterIds.includes(102))).toHaveLength(31);
  });

  it('anchors dates to 00:00 UTC of the given day, all in the past except the active sprint end', () => {
    expect(ds.sprints[3]?.startDate).toBe('2026-09-27T10:00:00.000+0000');
    const now = Date.parse('2026-10-04T15:30:00Z');
    for (const issue of ds.issues) {
      expect(time(issue.fields.updated)).toBeLessThanOrEqual(now);
      for (const h of issue.histories)
        expect(time(h.created)).toBeGreaterThanOrEqual(time(issue.fields.created));
    }
  });

  it('keeps keys unique, histories in time order and statuses consistent with the changelog', () => {
    expect(new Set(ds.issues.map((i) => i.key)).size).toBe(ds.issues.length);
    const statusIds = new Set(ds.statuses.map((s) => s.id));
    for (const issue of ds.issues) {
      const times = issue.histories.map((h) => time(h.created));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      const moves = issue.histories.flatMap((h) => h.items).filter((i) => i.field === 'status');
      const current = (issue.fields.status as { id: string }).id;
      expect(statusIds.has(current)).toBe(true);
      expect(moves.at(-1)?.to ?? '10000').toBe(current);
    }
  });
});
