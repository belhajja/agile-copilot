import { describe, expect, it } from 'vitest';
import { JiraToolError } from './backend';
import { summarizeWorklogs, type Worklog, worklogEntry, worklogOf } from './worklog-summary';

const entry = (author: string, started: string, seconds: number) =>
  worklogEntry({ author, started, seconds, comment: null }) as NonNullable<
    ReturnType<typeof worklogEntry>
  >;

const LOGS: Record<string, Worklog> = {
  'P-1': worklogOf(
    'P-1',
    [
      entry('Ana', '2026-10-01T09:00:00.000+0200', 7200),
      entry('Ben', '2026-10-02T09:00:00.000+0200', 3600),
    ],
    false,
  ),
  'P-2': worklogOf('P-2', [entry('Ana', '2026-10-03T09:00:00.000+0200', 1800)], false),
  'P-3': worklogOf('P-3', [entry('Ben', '2026-09-20T09:00:00.000+0200', 36000)], false),
};
const issues = (keys: string[]) => keys.map((key) => ({ key, summary: `Summary ${key}` }));
const deps = (over: Partial<Parameters<typeof summarizeWorklogs>[1]> = {}) => ({
  search: async () => ({ hasMore: false, issues: issues(['P-1', 'P-2', 'P-3']) }),
  worklog: async (key: string) => LOGS[key] as Worklog,
  signal: new AbortController().signal,
  ...over,
});

describe('worklogEntry', () => {
  it('keeps display names, exact seconds and a short plain comment', () => {
    expect(
      worklogEntry({
        author: 'Ana',
        started: '2026-10-01T09:00:00.000+0200',
        seconds: 5400,
        comment: 'x'.repeat(600),
      }),
    ).toEqual({
      author: 'Ana',
      started: '2026-10-01T09:00:00.000+0200',
      seconds: 5400,
      hours: 1.5,
      comment: 'x'.repeat(500),
    });
  });
  it('drops an entry without a usable duration', () => {
    expect(
      worklogEntry({ author: 'Ana', started: null, seconds: 'soon', comment: null }),
    ).toBeNull();
  });
});

describe('summarizeWorklogs', () => {
  it('totals per person and per issue', async () => {
    const s = await summarizeWorklogs({ jql: 'project = P' }, deps());
    expect(s).toMatchObject({
      jql: 'project = P',
      from: null,
      to: null,
      issuesScanned: 3,
      partial: false,
      totalHours: 13.5,
    });
    expect(s.byPerson).toEqual([
      { author: 'Ben', hours: 11, issues: 2 },
      { author: 'Ana', hours: 2.5, issues: 2 },
    ]);
    expect(s.topIssues[0]).toEqual({ key: 'P-3', summary: 'Summary P-3', hours: 10 });
  });

  it('keeps only entries between the dates, inclusive, by the day logged', async () => {
    const s = await summarizeWorklogs(
      { jql: 'project = P', from: '2026-10-01', to: '2026-10-02' },
      deps(),
    );
    expect(s.totalHours).toBe(3);
    expect(s.byPerson).toEqual([
      { author: 'Ana', hours: 2, issues: 1 },
      { author: 'Ben', hours: 1, issues: 1 },
    ]);
    expect(s.topIssues.map((i) => i.key)).toEqual(['P-1']);
  });

  it('scans at most 50 issues and says when there were more', async () => {
    let asked = 0;
    const s = await summarizeWorklogs(
      { jql: 'x' },
      deps({
        search: async (_jql, limit) => {
          asked = limit;
          return {
            hasMore: true,
            issues: issues(Array.from({ length: 50 }, (_, i) => `P-${i + 1}`)),
          };
        },
        worklog: async (key) => worklogOf(key, [], false),
      }),
    );
    expect(asked).toBe(50);
    expect(s).toMatchObject({ issuesScanned: 50, partial: true, totalHours: 0 });
  });

  it('never has more than 3 worklog requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await summarizeWorklogs(
      { jql: 'x' },
      deps({
        search: async () => ({
          hasMore: false,
          issues: issues(Array.from({ length: 12 }, (_, i) => `P-${i + 1}`)),
        }),
        worklog: async (key) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return worklogOf(key, [], false);
        },
      }),
    );
    expect(peak).toBe(3);
  });

  it('keeps going when one issue fails, flagged partial', async () => {
    const s = await summarizeWorklogs(
      { jql: 'x' },
      deps({
        worklog: async (key) => {
          if (key === 'P-2') throw new JiraToolError('forbidden');
          return LOGS[key] as Worklog;
        },
      }),
    );
    expect(s).toMatchObject({ issuesScanned: 3, partial: true, totalHours: 13 });
  });

  it('returns what it has when the deadline is reached', async () => {
    const ctrl = new AbortController();
    const s = await summarizeWorklogs(
      { jql: 'x' },
      deps({
        signal: ctrl.signal,
        worklog: async (key) => {
          if (key === 'P-1') return LOGS[key] as Worklog;
          ctrl.abort();
          throw new JiraToolError('unavailable');
        },
      }),
    );
    expect(s.partial).toBe(true);
    expect(s.totalHours).toBe(3);
  });

  it('treats any worker rejection after the deadline as partial, not a JiraToolError only', async () => {
    const ctrl = new AbortController();
    const s = await summarizeWorklogs(
      { jql: 'x' },
      deps({
        signal: ctrl.signal,
        worklog: async (key) => {
          if (key === 'P-1') return LOGS[key] as Worklog;
          ctrl.abort();
          // A transport error (SDK abort reason, timeout), not a JiraToolError.
          throw new Error('request aborted');
        },
      }),
    );
    expect(s.partial).toBe(true);
    expect(s.totalHours).toBe(3);
  });

  it('still lets a non-JiraToolError before the deadline propagate (a programming error)', async () => {
    await expect(
      summarizeWorklogs(
        { jql: 'x' },
        deps({
          worklog: async (key) => {
            if (key === 'P-2') throw new Error('boom');
            return LOGS[key] as Worklog;
          },
        }),
      ),
    ).rejects.toThrow('boom');
  });

  it('flags partial when an issue worklog was itself partial', async () => {
    const s = await summarizeWorklogs(
      { jql: 'x' },
      deps({
        worklog: async (key) => ({ ...(LOGS[key] as Worklog), partial: key === 'P-1' }),
      }),
    );
    expect(s.partial).toBe(true);
  });

  it('fails like the search when the search fails', async () => {
    await expect(
      summarizeWorklogs(
        { jql: 'x' },
        deps({
          search: async () => {
            throw new JiraToolError('invalid_request');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
