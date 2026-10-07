# Dashboard sprint filter

_Design approved in chat on 2026-10-07._

## Purpose

A board dashboard (`/boards/<id>`) shows each widget over the window stored in its params: the
last 6 sprints for velocity, average velocity and say/do ratio, the current or last closed sprint
for scope change and the burn charts, the last closed sprint for carry-over, and day or week
windows counted back from today for the flow metrics. A delivery manager cannot look at one
specific sprint (Sprint 77) or put several sprints side by side.

The dashboard gets a sprint picker. Choosing one sprint shows that sprint's numbers on every
widget that has a sprint meaning; choosing several compares them. Clearing the choice returns every
widget to its own default.

**Success:** from a board dashboard, in a few clicks, a user sees Sprint 77's velocity, say/do,
scope change, carry-over and burndown, and can add Sprint 76 to compare; the URL can be shared and
reopens the same view; nothing saved changes.

## Decisions

| Topic | Decision |
|---|---|
| Where the choice lives | One picker per dashboard page, applying to every tab; not saved per widget |
| Persistence | The URL only: `?sprints=<sprint id>,<sprint id>` (shareable, back button works) |
| Selection size | 1 to 10 sprints |
| Time-based widgets | Their window becomes the selected sprints' period |
| Forecasts and current-state widgets | Unchanged, with a "not filtered by sprint" note |
| Stored widgets, `pin_widget`, default dashboards | Unchanged; no database change |

## The picker

- Placed above the dashboard tabs on `/boards/<id>`. Shown only when the board has at least one
  sprint (Kanban boards without sprints: no picker).
- A button "Sprints" opens a searchable list (popover with a command list) of the board's sprints,
  newest first: future sprints first, then by start date descending (the order `list_sprints`
  uses). Each row shows the name, a state badge (active, closed, future) and the dates.
- Selected sprints show as removable chips next to the button, in chronological order (start date,
  then name), with a "Clear" button. Picking an 11th sprint is not possible (the list disables the
  remaining rows and says the limit).
- Changing the selection replaces the URL's `sprints` parameter (`router.replace`, no scroll
  reset); the page re-renders on the server with the new data.
- Labels in English and French (`dashboard.sprintFilter.*`).

## Reading the URL

`parseSprintSelection(raw, boardSprints)`, a pure function:

- `raw` is the `sprints` search parameter (string, string array or undefined).
- Splits on commas, trims, drops empty and duplicate values, keeps only ids that are sprints of
  this board (anything else, including another board's or workspace's sprint id, is ignored), and
  keeps at most 10 (the first 10 in URL order).
- Returns the matching `MetricSprint`s sorted chronologically (start date, sprints without a start
  date last, then name), or an empty list.
- An empty result means "no filter": the page behaves exactly as today.

## How widgets follow the selection

`computeWidget(spec, dataset, now, scope?)` gains an optional `scope: { sprints: MetricSprint[] }`
(non-empty, chronological). Without a scope every widget is computed exactly as today.

| Metric | One sprint selected | Several sprints selected |
|---|---|---|
| `velocity` (bar) | One row: committed vs completed of that sprint | One row per selected sprint, chronological. Closed sprints as today; an active sprint counts what is completed so far; future sprints are skipped |
| `average_velocity`, `say_do_ratio` (kpi) | The value over that sprint | The value over the selected closed sprints; KPI breakdown lists each sprint's own value. Active and future sprints are left out; none closed → empty `no_sprint` |
| `scope_change` (kpi) | That sprint (active or closed) | KPI value = the latest selected sprint's; breakdown lists every selected sprint's value |
| `carry_over` (kpi) | That sprint if closed, else empty `no_sprint` | Same rule per sprint; value = latest closed selected sprint's; breakdown lists each closed one |
| `sprint_burndown`, `sprint_burnup` (line) | That sprint, as today | One line per sprint (remaining for burndown, completed for burnup), x = day of sprint (`d1`, `d2`…), so sprints of different dates line up. Ideal/scope lines only with one sprint |
| `cycle_time`, `lead_time`, `flow_efficiency`, `throughput`, `throughput_rate`, `wip_trend`, `cfd` | Window = the period of the selected sprints | Same |
| `forecast_how_many`, `forecast_when`, `wip`, `aging_wip`, `hygiene` | Unchanged, plus `hint: notSprintFiltered` | Same |

**Period of the selection:** from the earliest start date to the latest end among the selected
sprints, where a sprint's end is its complete date, else its end date, else `now` (active), capped
at `now`. Sprints without a start date (future) do not count. If no selected sprint has a start
date, the time-based widgets return empty `no_data`.

For the time-based metrics the period replaces the relative window: the computation receives
explicit `from`/`to` dates instead of `windowDays`/`weeks`/`days` back from `now`. Throughput
buckets stay weekly; the trend charts keep daily rows over the period.

### Data shape changes (`widget-data.ts`)

- KPI: optional `breakdown?: { label: string; value: number | null }[]` (label = sprint name, shown
  as-is, not a message key). The KPI card renders it as a compact list under the value.
- Series: each series entry may carry `label?: string` (a literal display name) instead of being a
  message key; used for the per-sprint lines. Existing series keep their keys.
- Hints: new message keys `dashboard.hints.selectedSprints` ("{count} selected sprints") and
  `dashboard.hints.notSprintFiltered` ("Not filtered by sprint").

## Page flow

`/boards/[boardId]/page.tsx` reads `searchParams.sprints`, loads the dataset as today, computes
`scope = parseSprintSelection(...)`, and passes it to every `computeWidget` call (all tabs). It
also passes the board's sprints (id, name, state, dates) and the current selection to the picker.

## Out of scope

- Saving a selection per widget, or remembering it per user.
- Changing what the assistant pins or the `get_metric` tool (the assistant already answers
  sprint-specific questions with `list_sprints` and the live Jira tools).
- Filtering by date range or by release.

## Testing

- **Unit (`packages/dashboards`, Vitest):** `parseSprintSelection` (comma list, array form,
  duplicates, unknown and foreign ids, more than 10, empty → no filter, chronological order);
  `computeWidget` with a scope for each row of the table above: one sprint, several, only future
  sprints, an active sprint, and no scope (output identical to today's, guarded by the existing
  tests); the period rule (complete vs end vs now, capped at now).
- **Metrics (`packages/metrics`):** the explicit-period variants of the time-based functions
  return the same results as the relative ones for an equivalent period.
- **Web:** the picker's URL building (add, remove, clear, limit) as a pure helper with a test; the
  KPI breakdown and multi-line series render (component tests if the project has them, otherwise
  covered by the browser check).
- **Browser check:** on the demo board, pick one sprint, then two, check the widgets change and the
  URL round-trips; clear it.
