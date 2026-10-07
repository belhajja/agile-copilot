# Pinnable assistant queries

_Design approved in chat on 2026-10-07._

## Purpose

The assistant answers data questions in Markdown: tables as Markdown tables, graphs as Mermaid
diagrams. They are pictures of the data at answer time and cannot be put on a dashboard. Dashboard
widgets are a fixed catalog of metrics recomputed on every page load.

A delivery manager asks the assistant "open bugs per assignee" or "points per sprint by type", sees
a table or chart, and wants it on the board's dashboard, live. This design adds a board query the
assistant writes, renders its result in chat with the dashboard's own components, and lets the
user pin it as a widget that is recomputed from synced data on every load.

**Success:** from a chat answer built from a query, one click pins it; the board's "Pinned"
dashboard then shows the same table or chart, updated after each sync and following the sprint
filter.

## Decisions

| Topic | Decision |
|---|---|
| Freshness | Always live: a pinned item is a query recomputed on each dashboard load |
| Engine | One `runQuery` in `packages/dashboards`, used by the chat tool and the dashboard |
| Data | Synced board data only (no live Jira calls at render time) |
| New synced fields | labels, components, fix versions, priority, epic (key and name) |
| Storage | A widget spec `{ metric: 'query', chart, title, params: <query> }`; no new widget tables |
| Chat rendering | Real widget components on the tool card, not Markdown or Mermaid |
| Pinning | A Pin button on each result card (`via: 'user'`), or asking the assistant (`pin_widget`) |
| Conversation history | Shows the result as it was at answer time, dated; only the pinned widget is live |
| Editing | None in v1: ask for a new one, pin it, remove the old one |

## Architecture

```
User asks in chat ─► assistant calls query_board(boardId, query)        (analytics MCP)
                         ▼
               runQuery(dataset, query, now) ──► WidgetData (kpi / series / table)
                         ▼
        tool card renders it with the dashboard components + "Pin to dashboard"
                         ▼
   pinWidget(... { metric: 'query', chart, title, params: query }, via: 'user' | 'assistant')
                         ▼
   dashboard page load ─► computeWidget ─► runQuery on fresh synced data ─► same component
```

- `get_metric` results get the same card rendering and Pin button (they already are widget specs).
- The system prompt tells the model not to redraw `query_board` / `get_metric` data as a Markdown
  table or Mermaid chart, and to comment on it in a sentence or two. Mermaid stays for non-data
  diagrams.

## The query language

A JSON spec validated with zod (`boardQuerySchema`). Every time reference is relative so the widget
stays live.

```ts
type BoardQuery = {
  title: string;                         // card title, 1–80 chars
  filter?: {
    types?: string[];                    // issue type names
    statuses?: string[];                 // Jira status names
    statusCategory?: ('todo' | 'in_progress' | 'done')[];
    assignees?: (string | null)[];       // display names; null = unassigned
    labels?: string[];
    epics?: string[];                    // epic keys
    priorities?: string[];
    components?: string[];
    fixVersions?: string[];
    sprints?: SprintRef[];
    created?: Window;
    resolved?: Window;
    includeSubtasks?: boolean;           // default false
  };
  groupBy?: Dimension[];                 // 0–2
  measure?: Measure;                     // default 'count'
  display: Display;
  list?: { columns: Column[]; sort?: { by: Column; dir: 'asc' | 'desc' }; limit?: number };
  top?: number;                          // 1–20: keep the N largest groups, the rest as "Other"
};

type Dimension = 'type' | 'status' | 'statusCategory' | 'assignee' | 'label' | 'epic'
  | 'priority' | 'component' | 'fixVersion' | 'sprint'
  | 'createdWeek' | 'createdMonth' | 'resolvedWeek' | 'resolvedMonth';
type Measure = 'count' | 'points' | 'avg_cycle_time' | 'p85_cycle_time' | 'avg_age';
type Display = 'kpi' | 'table' | 'bar' | 'stacked_bar' | 'line' | 'pie' | 'list';
type SprintRef = 'active' | 'last_closed' | { lastClosed: number } | { id: string };  // lastClosed 1–20
type Window = { lastDays: number } | { sinceSprintsAgo: number };                     // 1–730 / 1–20
type Column = 'key' | 'summary' | 'type' | 'status' | 'assignee' | 'points' | 'priority'
  | 'epic' | 'labels' | 'created' | 'resolved' | 'age';
```

### Semantics

- **Filters** combine with AND; values inside one filter combine with OR. Name matching is exact
  and case-insensitive. Unknown names match nothing (no error).
- **Sprints:** an issue matches a sprint if it was a member of it at any time. `active` follows the
  board's active sprint(s); `last_closed` is the most recently completed one.
- **Windows:** `lastDays: n` is `(now − n days, now]`; `sinceSprintsAgo: n` starts at the start of
  the n-th most recent started sprint.
- **Measures:**
  - `count` is the number of issues.
  - `points` is the sum of current estimates; on a board without estimates it falls back to
    `count` with a note.
  - `avg_cycle_time` and `p85_cycle_time` are in days, over resolved issues, using the same
    definition as the `cycle_time` metric.
  - `avg_age` is in days since creation, over unresolved issues.
- **Grouping:**
  - Multi-valued dimensions (label, component, fixVersion, sprint) count an issue in each of its
    groups, and the card notes it.
  - An issue with no value goes in a "None" group (for example "Unassigned").
  - Time dimensions use UTC weeks (Monday) and months, and fill empty buckets with 0 across the
    filtered window.
  - Sprint groups are chronological, time groups are ascending, other groups are sorted by value
    in descending order.
- **Result shape:**

  | Query shape | Displays allowed | Result |
  |---|---|---|
  | no `groupBy` | `kpi` | one value |
  | one dimension | `table`, `bar`, `pie`, `line` (time dimension or sprint only) | one value per group |
  | two dimensions | `stacked_bar`, `table` (pivot) | one series per second-dimension value |
  | `list` | `list` | matching issues: the requested columns, sorted, limit 1–50 (default 20); no `groupBy` |

- **Caps:** at most 20 groups (with `top`) plus "Other" (a 21st group is folded into Other even
  without `top`), 50 list rows, a 4 KB serialized query, and 10 values per filter. Caps truncate
  with a note; they never refuse.
- **Invalid combinations are refused** with the paths at fault: `pie` with 2 dimensions, `line` on
  a non-time, non-sprint dimension, `list` with `groupBy`, `kpi` with `groupBy`, `stacked_bar` with
  fewer than 2 dimensions, the same dimension twice.

### Examples

| Question | Query (short form) |
|---|---|
| Open bugs per assignee | `filter {types:[Bug], statusCategory:[todo,in_progress]}, groupBy [assignee], display bar` |
| Points per sprint by type, last 6 sprints | `filter {sprints:[{lastClosed:6}]}, groupBy [sprint,type], measure points, display stacked_bar` |
| Bugs created per week, last 90 days | `filter {types:[Bug], created:{lastDays:90}}, groupBy [createdWeek], display line` |
| Unassigned in-progress issues | `filter {assignees:[null], statusCategory:[in_progress]}, display list` |
| Cycle time by issue type | `filter {resolved:{lastDays:60}}, groupBy [type], measure p85_cycle_time, display table` |

Not included: OR/NOT across filters, free text, JQL, other custom fields, sources other than issues.

## Data shape

`runQuery(dataset, query, { now, scope? })` returns the existing `WidgetData`:

- `kpi` returns `{ kind: 'kpi', value, format }`. The format is `issues`, `points`, `days` or
  `percent`.
- `bar`, `stacked_bar`, `line` and `pie` return `kind: 'series'`.
  - The chart is the display; `pie` is a new chart value in `WidgetData`.
  - The x key is the first dimension.
  - Series are either a single `value` series, or one per second-dimension value, using
    `label` (literal names).
- `table` and `list` return `kind: 'table'` with literal column labels.
  - Table columns gain an optional `label?: string` (used instead of a message key) and a `link`
    type for issue keys (rendered as a Jira link via the board's connection).
- Notes (multi-valued grouping, a cap reached, the points fallback, fields still syncing) use the
  existing `hint` mechanism with new message keys under `dashboards.query.*`.

## Agent and chat

- **`query_board` tool (analytics MCP):**
  - Input: `{ boardId, query }`. It parses with `boardQuerySchema` and loads the board dataset like
    `get_metric`, then runs `runQuery`.
  - Output (as untrusted data): `{ board, query, data, computedAt }`.
  - Errors: `invalid_query` (with paths), `unknown_board`, and the internal error as `get_metric`
    does it.
- **`list_metrics`** describes `query` (the schema in short, the examples), so the model can use
  `query_board` and `pin_widget` with `metric: 'query'`.
- **`pin_widget`:**
  - Accepts `metric: 'query'` with `chart` = the query's display and `params` = the query.
  - The params cap of 10 keys stays: a query has at most 7 top-level keys.
  - `title` defaults to the query's title.
- **Chat tool card:**
  - For `query_board` and `get_metric` results it renders `data` with `KpiCards`, `WidgetChart` and
    `WidgetTable` (the same components as the dashboard), the board name and "as of <time>".
  - A **Pin to dashboard** button calls a server action that runs `pinWidget(... via: 'user')`.
  - On success the button becomes "Pinned · Open dashboard"; errors (`dashboard_full`,
    `unknown_board`) show inline.
  - The pin is audited like the assistant's.
- **History:** the stored tool output is the snapshot; it is never recomputed.

## Dashboard

- `widgetSpecSchema` gains `widget('query', DISPLAYS, boardQuerySchema)`.
  - `chart` must equal `params.display`.
  - `computeWidget` routes `metric: 'query'` to `runQuery`.
- **Sprint filter:** with a selection, a query without its own `sprints` filter keeps only issues
  that were members of a selected sprint. A query with its own `sprints` filter is computed
  unchanged and flagged `unfiltered`.
- A stored query that no longer parses (future schema change) renders a "This widget can't be shown
  anymore — ask the assistant for a new one" card instead of failing the page.
- Removal uses the existing remove button. There is no editor.

## Sync

- **Migration:** `jira_issues` gains:
  - `labels text[] not null default '{}'`, `components text[] not null default '{}'` and
    `fix_versions text[] not null default '{}'`;
  - `priority text`, `epic_key text` and `epic_name text`.

  The `jira_boards` table gains `needs_full_sync boolean not null default false`, set to true for
  every board by the migration.
- **Fields requested:** `labels`, `priority`, `components`, `fixVersions` and `parent`, plus the
  epic link custom field.
  - The epic link field is found the way `findSprintField` finds the sprint field (Data Center:
    custom type `com.pyxis.greenhopper.jira:gh-epic-link`).
- **Epic:**
  - Data Center: the epic link value is a key. Epic names are fetched once per sync with one
    search on those keys (fields `summary` plus the epic name field when present, else the
    summary).
  - Cloud: `parent` when its issue type is Epic, with its summary as the name.
- **Normalization** is lenient: a missing or malformed value becomes empty or null and never fails
  the sync.
- **Full resync:** a board with `needs_full_sync` does a full sync next time, then clears the flag.
  - Until it has, a query that filters or groups on a new field adds the hint
    `dashboards.query.fieldsSyncing`.
- `MetricIssue` gains `labels`, `components`, `fixVersions`, `priority`, `epicKey` and `epicName`,
  loaded with the dataset. Existing metrics ignore them.

## Security

- Queries are pure data: no JQL or SQL is built from them. They run only on the caller's org's
  dataset, which the existing RLS protects.
- Issue text in results (summaries, labels, names) reaches the model wrapped in `asUntrustedData`
  and is rendered escaped (React). It is never put into Markdown.
- `pinWidget` keeps its checks: the caller's own dashboard, and a board selected in their
  workspace.

## Errors

| Case | Behavior |
|---|---|
| Invalid query from the model | `invalid_query` with paths; the model fixes it |
| Board not synced / nothing matches | Existing empty card (`no_data`), hint "No issue matches" |
| Too many groups / rows | Truncated with a note |
| Pin fails | Same codes as `pin_widget`; shown inline on the button |
| DB failure | Same handling as `get_metric`; no internal text to the model |
| Stored query no longer valid | Explanatory card, page renders |

## Testing

- **`runQuery` (Vitest, metrics fixtures extended with the new fields):**
  - each filter, each dimension (multi-valued counted per group), and each measure, including
    points with no estimates;
  - empty time buckets, `top` and Other, list sort and limit;
  - windows anchored on `now`, sprint references as sprints change;
  - the sprint-filter interaction.
- **Schema:** the five examples parse; each invalid combination is refused with its path; the caps
  hold.
- **Sync:**
  - Normalization: Data Center epic link, Cloud parent, empty or malformed values, the epic name
    lookup.
  - The Jira mock is extended with labels and epics, and the `needs_full_sync` flow is covered.
  - A migration test (Testcontainers) checks that old rows stay valid.
- **Agent:**
  - `query_board` success and errors;
  - `pin_widget` with a query;
  - the prompt contains the no-redraw rule.
- **Web:**
  - the result card renders from the same `WidgetData` as the dashboard;
  - the Pin button's states;
  - message keys in EN and FR.
- **e2e:** the mock LLM calls `query_board`; the user pins it; the dashboard shows the widget.
- **Browser check:** the DEMO board; three example questions; pin; the dashboard with the sprint
  filter on.

## Out of scope

- An editor for pinned queries, and sharing pinned widgets with other users.
- Live Jira (JQL) widgets and data from other projects.
- Custom fields beyond the listed ones.
- Recomputing old conversation results.
