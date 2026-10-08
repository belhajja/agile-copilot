# Changelog

Notable changes to Agile Copilot. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
releases are Git tags (e.g. `v1.0.0`), whose images CI publishes to the GitLab registry (see the README).

## [Unreleased]

### Added

- Pinnable assistant queries: the assistant can query a board (a small board query language over
  synced issues) and show the result as a widget, which can be pinned to a dashboard from the
  chat. Query widgets support notes, pies, group labels and month buckets.
- Sync stores labels, components, fix versions, priority and epic of issues (migration `0037`),
  for board queries.
- Sprint filter on the board dashboard: pick sprints to scope or compare them, with per-sprint
  breakdowns and compared burn lines; velocity for a single sprint, active ones included.
- `deploy/compose`: one compose file and `.env.example` for running the published images.
- `docs/migrations.md`: how to write migrations that are safe to deploy.
- Helm: `networkPolicy.appEgress` (Postgres, `extraCIDRs`, `extraRules`) for the web and worker
  egress, and a `NOTES.txt` warning while the image repositories are the placeholders.

### Changed

- Helm: `networkPolicy.webIngressFrom` defaults to the ingress-nginx controller pods instead of
  every pod; set it to your controller (or `[]` to open it again). Web and worker egress is
  restricted to DNS, Postgres, mcp-atlassian and public IPv4 addresses: list private destinations
  (Data Center Jira, LLM gateway, SMTP, identity provider) in `networkPolicy.appEgress.extraCIDRs`
  before upgrading.
- CI: the e2e suite runs against node-build's standalone build; the e2e, evals, Helm and docker
  jobs have timeouts; the trivy gate is explicit (HIGH and CRITICAL with a fix); the evals cache
  the promptfoo download.
- CI pulls every Docker Hub image, including image base layers, through Orange's mirror.
- The runtime images apply Alpine security updates.

### Removed

- The Docker operator (install, upgrade, backup and restore CLI and its updater service). Deploy
  with the compose files in `deploy/compose` or the Helm chart instead.

### Fixed

- Dashboards: a query's sprint is found by its Jira number; recent weeks or months of a time
  dimension are kept without a window; series of a second dimension are capped; a query widget's
  chart matches its display.
- Agent: tool calls left unanswered by a failed reply are closed.
- Sync: only epic names that changed are rewritten, and a failed epic lookup is retried in halves
  so the other names are kept.
- Web: repeated widget notes get unique keys.
