# Feature ideas

_Brainstormed 2026-10-06. Not committed to a plan yet; each item goes through design and spec before it is built._

Top picks for how the product is used today: **Sprint report page**, **Timesheet view**, **Sprint review pack**.

## Sprint and planning
- **Sprint report page** ⭐ — per sprint: official dates, committed vs completed, carry-over, scope added, hours estimated vs logged, per person. A page and an export, instead of the assistant rebuilding it from many searches.
- **Sprint planning assistant** — proposes a sprint scope from the backlog using real velocity and each person's capacity (logged-time history, absences); warns before over-commitment.
- **Release and epic forecast** — "when will version 1.2 / epic X be done?" with the Monte Carlo forecast per version or epic, plus what-ifs (remove stories, add a person).

## Time and team
- **Timesheet view** ⭐ — hours logged per person per day/week across boards, gaps highlighted, optional reminder to people who forgot to log.
- **Estimation accuracy** — estimate vs actual per person, issue type or epic over past sprints.
- **Workload balance** — open estimate per person vs capacity; who is overloaded or idle next sprint.

## Ceremonies
- **Sprint review pack** ⭐ — delivered items, demo list, key metrics and risks, exported as PowerPoint or published as a Confluence page.
- **Retrospective assistant** — prepares the retro from sprint data (slips, blockers, bounced issues), collects anonymous team input, turns agreed actions into Jira issues (with approval).
- **Backlog refinement helper** — flags stories without acceptance criteria, oversized stories, likely duplicates, stale tickets; proposes splits or acceptance criteria to approve.

## Sharing and reach
- **Assistant in Microsoft Teams** — ask questions from a Teams channel; scheduled digests there.
- **Stakeholder weekly report across boards** — one summary across teams (the deferred portfolio view).
- **Ask your Confluence** — answers from team documentation as well as Jira (the OpenRama gateway already serves the `bge-m3` embedding model).

## Engineering flow
- **GitLab link** — merge requests and pipelines tied to Jira issues; code-to-delivery time, stories stuck in review or CI (DORA metrics: lead time, deployment frequency, failure rate).
