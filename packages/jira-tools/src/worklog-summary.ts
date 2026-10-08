import { JiraToolError } from './backend';

export interface WorklogEntry {
  author: string | null;
  started: string | null;
  seconds: number;
  hours: number;
  comment: string | null;
}

export interface Worklog {
  issueKey: string;
  totalHours: number;
  entries: WorklogEntry[];
  /** Not every entry could be read (paging limit). */
  partial: boolean;
}

export interface WorklogSummary {
  jql: string;
  from: string | null;
  to: string | null;
  issuesScanned: number;
  partial: boolean;
  totalHours: number;
  byPerson: { author: string; hours: number; issues: number }[];
  topIssues: { key: string; summary: string | null; hours: number }[];
}

const WORKLOG_SUMMARY_MAX_ISSUES = 50;
/** Jira Data Center rate limits are token buckets (e.g. 60 then 1 per second): stay well below. */
const WORKLOG_SUMMARY_CONCURRENCY = 3;
const WORKLOG_COMMENT_MAX = 500;
const TOP_ISSUES = 10;
const UNKNOWN_AUTHOR = 'Unknown';

const hours = (seconds: number) => Math.round(seconds / 360) / 10;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** One worklog entry, or null when it has no usable duration. */
export function worklogEntry(raw: {
  author: unknown;
  started: unknown;
  seconds: unknown;
  comment: unknown;
}): WorklogEntry | null {
  const seconds = raw.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const comment = text(raw.comment);
  return {
    author: text(raw.author),
    started: text(raw.started),
    seconds,
    hours: hours(seconds),
    comment: comment ? comment.slice(0, WORKLOG_COMMENT_MAX) : null,
  };
}

export function worklogOf(issueKey: string, entries: WorklogEntry[], partial: boolean): Worklog {
  return {
    issueKey,
    totalHours: hours(entries.reduce((sum, e) => sum + e.seconds, 0)),
    entries,
    partial,
  };
}

/** The calendar day a worklog was logged for, as Jira wrote it ("2026-10-01T09:00:00.000+0200"). */
const dayOf = (started: string | null) =>
  started && /^\d{4}-\d{2}-\d{2}/.test(started) ? started.slice(0, 10) : null;

/**
 * Time logged on the issues `jql` matches (at most 50), per person and per issue. Worklogs are
 * fetched a few at a time; an issue whose worklog fails, or the call's deadline, makes the result
 * partial instead of failing it. Only the search failing fails the call.
 */
export async function summarizeWorklogs(
  input: { jql: string; from?: string; to?: string },
  deps: {
    search(
      jql: string,
      limit: number,
    ): Promise<{ hasMore: boolean; issues: { key: string | null; summary: string | null }[] }>;
    worklog(issueKey: string): Promise<Worklog>;
    signal: AbortSignal;
  },
): Promise<WorklogSummary> {
  const found = await deps.search(input.jql, WORKLOG_SUMMARY_MAX_ISSUES);
  const issues = found.issues
    .filter((i): i is { key: string; summary: string | null } => typeof i.key === 'string')
    .slice(0, WORKLOG_SUMMARY_MAX_ISSUES);
  let partial = found.hasMore || found.issues.length > WORKLOG_SUMMARY_MAX_ISSUES;
  const from = input.from ?? null;
  const to = input.to ?? null;
  const inRange = (e: WorklogEntry) => {
    if (!from && !to) return true;
    const day = dayOf(e.started);
    return day !== null && (!from || day >= from) && (!to || day <= to);
  };

  const perIssue = new Map<string, number>();
  const perPerson = new Map<string, { seconds: number; issues: Set<string> }>();
  let next = 0;
  const worker = async () => {
    while (next < issues.length && !deps.signal.aborted) {
      const issue = issues[next++] as { key: string; summary: string | null };
      let log: Worklog;
      try {
        log = await deps.worklog(issue.key);
      } catch (e) {
        // A JiraToolError is always a partial result, not a failure; once the deadline has hit,
        // any rejection is too (the deadline itself, or a transport error racing it) — anything
        // else, before the deadline, is a programming error and must still propagate.
        if (!(e instanceof JiraToolError) && !deps.signal.aborted) throw e;
        partial = true;
        continue;
      }
      if (log.partial) partial = true;
      for (const e of log.entries.filter(inRange)) {
        perIssue.set(issue.key, (perIssue.get(issue.key) ?? 0) + e.seconds);
        const author = e.author ?? UNKNOWN_AUTHOR;
        const p = perPerson.get(author) ?? { seconds: 0, issues: new Set<string>() };
        p.seconds += e.seconds;
        p.issues.add(issue.key);
        perPerson.set(author, p);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WORKLOG_SUMMARY_CONCURRENCY, issues.length) }, worker),
  );
  if (next < issues.length) partial = true;

  const summaries = new Map(issues.map((i) => [i.key, i.summary]));
  const total = [...perIssue.values()].reduce((a, b) => a + b, 0);
  return {
    jql: input.jql,
    from,
    to,
    issuesScanned: issues.length,
    partial,
    totalHours: hours(total),
    byPerson: [...perPerson.entries()]
      .sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))
      .map(([author, p]) => ({ author, hours: hours(p.seconds), issues: p.issues.size })),
    topIssues: [...perIssue.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_ISSUES)
      .map(([key, seconds]) => ({
        key,
        summary: summaries.get(key) ?? null,
        hours: hours(seconds),
      })),
  };
}
