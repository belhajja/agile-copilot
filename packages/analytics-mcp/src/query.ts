/** The query_board tool's description: the language, in the model's terms (English). */
export const QUERY_GUIDE = `Run a query on a board's synced issues (deterministic). Use it for counts, breakdowns, trends and lists of issues. The app shows the result as a table or chart with a "Pin to dashboard" button.
query = {
  title: short card title (≤ 80 chars),
  filter?: { types?, statuses?, priorities?, labels?, components?, fixVersions?, epics? (keys or names): string[] (≤ 10 each, case-insensitive);
             statusCategory?: ("todo"|"in_progress"|"done")[]; assignees?: (display name | null for unassigned)[];
             sprints?: ("active" | "last_closed" | {lastClosed: n≤20} | {id: the sprint number (jiraSprintId) from list_sprints})[];
             created?, resolved?: {lastDays: n≤730} | {sinceSprintsAgo: n≤20} },
  groupBy?: 1–2 of type, status, statusCategory, assignee, label, epic, priority, component, fixVersion, sprint, createdWeek, createdMonth, resolvedWeek, resolvedMonth,
  measure?: count (default) | points | avg_cycle_time | p85_cycle_time | avg_age,
  display: kpi (no groupBy) | bar, pie (1 dimension) | line (1 time or sprint dimension) | stacked_bar (2 dimensions) | table (1 or 2 dimensions) | list (issues, no groupBy),
  list?: { columns: key, summary, type, status, assignee, points, priority, epic, labels, created, resolved, age; sort?: {by: column, dir: asc|desc}; limit?: ≤ 50 } (display list only),
  top?: n ≤ 20 (keep the largest groups, the rest as "Other"; categories only)
}
When grouping by createdWeek/createdMonth or resolvedWeek/resolvedMonth, always set the matching created or resolved window (e.g. {"lastDays":90}); without one only the most recent 26 weeks or 24 months are kept.
Examples: open bugs per assignee = {"title":"Open bugs per assignee","filter":{"types":["Bug"],"statusCategory":["todo","in_progress"]},"groupBy":["assignee"],"display":"bar"};
points per sprint by type = {"title":"Points per sprint by type","filter":{"sprints":[{"lastClosed":6}]},"groupBy":["sprint","type"],"measure":"points","display":"stacked_bar"};
unassigned work in progress = {"title":"Unassigned in progress","filter":{"assignees":[null],"statusCategory":["in_progress"]},"display":"list","list":{"columns":["key","summary","status"]}}.`;
