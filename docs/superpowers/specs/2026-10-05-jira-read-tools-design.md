# More live Jira read tools (time tracking and delivery context) — Design Spec

_Status: draft for review · 2026-10-05_

## Context
Asked for an issue's original estimate and its worklogs, the assistant said its tools could not do
it, and it was right. The live Jira tools are an allowlist of 11 (out of ~60 in mcp-atlassian
0.23.1), each with our own narrow schema:
- `jira_get_issue` / `jira_search` / `jira_get_sprint_issues` never ask for time-tracking fields
  (mcp-atlassian's default field set and our REST client's `FIELDS` both leave them out);
- mcp-atlassian's read-only `jira_get_worklog` is not in the catalog nor in the container's
  `ENABLED_TOOLS`, so the model never sees it.

Two gates decide what the model can call: the container's `ENABLED_TOOLS` (generated from our
catalog, kept in sync with the compose files and Helm by tests) and the catalog itself
(`packages/jira-tools/src/catalog.ts`). Cloud API-token connections do not use mcp-atlassian:
our REST backend implements each catalog tool.

### Decisions made with the user
| Topic | Decision |
|---|---|
| Needs | Per issue: estimates; per issue: worklog entries; across issues: totals (sprint / JQL) |
| Scope | The read-only group below; no write tools; no admin page for tool toggles |
| Cross-issue totals | Our own tool `jira_worklog_summary` (bounded, server-side aggregation) |
| Cloud API token | Simple tools on both backends; 4 composite tools on mcp-atlassian connections only |
| Roles | Unchanged: live Jira reads for owners, admins, managers; viewers get none |
| External AI clients (`/api/mcp`) | Unchanged: analytics only, no live Jira tool |

Deliberately left off (not offered at all): delete/move issue, removals and comment edits,
attachments and issue images, bulk creates, sprint/version administration, remote links, Forms and
Service Desk tools, `jira_get_user_profile` (personal data), project/field metadata tools,
`jira_get_project_issues` (duplicates `jira_search`), development info. Write tools are out of
scope (`jira_add_worklog`, issue links, epic links, sprint moves, watchers could come later through
the approval flow).

---

## The tools

| Tool | Input (narrow, bounded) | mcp-atlassian connections | Cloud API token (REST) |
|---|---|---|---|
| time tracking on `jira_search`, `jira_get_issue`, `jira_get_sprint_issues` | unchanged | request `timeoriginalestimate,timeestimate,timespent` besides today's fields | add the same to `FIELDS` |
| `jira_get_worklog` | `issueKey` | native | `GET /rest/api/2/issue/{key}/worklog` (paged) |
| `jira_worklog_summary` (ours) | `jql` (≤ 2000), `from?`, `to?` (YYYY-MM-DD) | `jira_search` + `jira_get_worklog` | same calls on REST |
| `jira_get_board_issues` | `boardId`, `jql?`, `limit` ≤ 50 | native | `GET /rest/agile/1.0/board/{id}/issue` |
| `jira_batch_get_changelogs` | `issueKeys` (1-20 keys) | native | per issue, `expand=changelog` |
| `jira_get_link_types` | none | native | `GET /rest/api/2/issueLinkType` |
| `jira_get_project_versions` | `projectKey` | native | `GET /rest/api/2/project/{key}/versions` |
| `jira_get_project_components` | `projectKey` | native | `GET /rest/api/2/project/{key}/components` |
| `jira_get_issue_watchers` | `issueKey` | native | `GET /rest/api/2/issue/{key}/watchers` |
| `jira_get_issue_dates` | `issueKey` | native | `not_supported` |
| `jira_get_project_epic_hierarchy` | `projectKey`, `maxEpics` ≤ 20 | native | `not_supported` |
| `jira_get_cross_project_dependencies` | `projectKey`, `maxIssues` ≤ 50 | native | `not_supported` |
| `jira_search_fields` | `keyword`, `limit` ≤ 20 | native | `not_supported` |

### Output shapes (both backends return the same shape for a tool)
- **Time tracking** on issues: `originalEstimateHours`, `remainingEstimateHours`,
  `timeSpentHours` — numbers rounded to 0.1, `null` when Jira has no value. Seconds ÷ 3600 (Jira
  stores seconds; the "1d = 8h" display convention plays no part).
- **Worklog:** `{ issueKey, totalHours, entries: [{ author, started, hours, comment }] }`;
  `author` is a display name, `started` ISO 8601, `comment` plain text cut to 500 characters.
- **Worklog summary:** `{ jql, from, to, issuesScanned, partial, totalHours,
  byPerson: [{ author, hours, issues }], topIssues: [{ key, summary, hours }] }` — `byPerson`
  sorted by hours (desc), `topIssues` the 10 largest. Entries outside `[from, to]` (by `started`,
  inclusive dates) are left out. `partial: true` when the JQL matched more than 50 issues (only
  the first 50 scanned) or an issue's worklog could not be read completely.
- **Watchers:** display names only (no email, no account id, no username).
- Other tools: the fields mcp-atlassian returns, mapped to a compact shape the REST backend
  reproduces (key, name/summary, status, dates, as relevant), never raw Jira JSON.

### Worklog summary limits
At most 50 issues; worklogs fetched **3 at a time** (the user's Data Center answers with a token
bucket of 60 requests refilling 1 per second; 50 parallel calls would trip `429`). The whole call
stays within the backend's existing per-call deadline; on deadline the partial result is returned
with `partial: true` rather than an error.

### Composite tools on REST sites
A tool marked mcp-only is offered only when at least one usable site uses mcp-atlassian; with
several sites its `site` enum lists those sites only. A call that still reaches a REST site fails
with a new `JiraToolError('not_supported')` → agent tool error `not_supported` (sentence: "This
tool needs a Jira Data Center or Connect-with-Atlassian connection.").

### Allowlists
- `MCP_ATLASSIAN_ENABLED_TOOLS` and the read-only twin's list gain every new native tool;
  `jira_worklog_summary` is ours (not an mcp-atlassian tool) and stays out of both.
- All new tools are `write: false`: they are in the read-only twin's list, which therefore lets
  skill runs use them; the twin keeps `READ_ONLY_MODE=true`.
- `docker-compose.yml`, `docker-compose.selfhost.yml` and the Helm template follow the generated
  lists (existing sync tests).

---

## Safety
1. **Read-only:** no new write path, no approval card, no change audit.
2. **Roles unchanged:** owners, admins, managers; re-checked at execution.
3. **Jira text is data:** worklog comments, changelog values, version/component descriptions and
   watcher names reach the model inside the untrusted-data envelope, never as instructions.
4. **No personal data beyond display names** (watchers, worklog authors).
5. **Bounded:** every list input and output has a cap; per-call deadline unchanged; the summary's
   concurrency respects the Jira rate limit.

## Prompt
One sentence in the chat prompt (and the run prompt, since runs get the read tools): issue reads
include estimate and time-spent values in hours; `jira_get_worklog` lists one issue's entries;
`jira_worklog_summary` answers per-person or sprint totals in one call.

## Messages (EN/FR)
`agent.tools.<name>` for each new tool; `agent.toolErrors.not_supported`.

## Testing
- **Catalog:** input bounds per new tool; `toMcp`/`fromMcp` round trip; allowlists include the new
  native tools and exclude `jira_worklog_summary`; the read-only list has no write tool.
- **mcp backend:** time-tracking fields requested; hours conversion; worklog mapping.
- **REST backend:** endpoints and paging per supported tool; changelog via `expand`; the 4
  composite tools → `not_supported`.
- **Worklog summary:** per-person and per-issue totals, the date filter (inclusive), `partial`
  above 50 issues and on deadline, never more than 3 worklog requests in flight.
- **Agent:** mcp-only tools absent for a single REST site; `site` enum limited with several sites;
  `not_supported` mapped to its sentence.
- **Contract test** (pinned mcp-atlassian image): the new native tools exist and accept the
  arguments we send.
- **Compose / Helm** sync tests; **e2e double** serves the new tools; **evals:** a "time logged
  per person in a sprint" case through `jira_worklog_summary`.
- **Manual:** on the real Data Center Jira and model — an issue's original estimate, its
  worklogs, time per person for the current sprint.

## Delivery
Branch `feat/jira-read-tools` from `develop`; merged locally into `develop`.
