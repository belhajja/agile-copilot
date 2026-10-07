import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jiraConnections } from './app';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

// Every table here hangs off jira_connections with ON DELETE CASCADE: removing a connection (or
// purging an org) removes everything synced from it.
const connectionRef = () =>
  uuid('connection_id')
    .notNull()
    .references(() => jiraConnections.id, { onDelete: 'cascade' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const jiraBoardType = pgEnum('jira_board_type', ['scrum', 'kanban', 'simple']);
export const statusCategory = pgEnum('status_category', ['todo', 'in_progress', 'done']);
export const statusMappingSource = pgEnum('status_mapping_source', ['auto', 'user']);
export const jiraSprintState = pgEnum('jira_sprint_state', ['future', 'active', 'closed']);
export const jiraIssueChangeKind = pgEnum('jira_issue_change_kind', ['estimate', 'flag']);
export const syncStatus = pgEnum('sync_status', ['idle', 'queued', 'running', 'ok', 'error']);
export const syncTrigger = pgEnum('sync_trigger', ['manual', 'schedule']);
export const syncMode = pgEnum('sync_mode', ['incremental', 'full']);

/** A board column and the Jira status ids it holds (from the board configuration). */
export interface BoardColumn {
  name: string;
  statusIds: string[];
}

export const jiraBoards = pgTable(
  'jira_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    jiraBoardId: integer('jira_board_id').notNull(),
    name: text('name').notNull(),
    type: jiraBoardType('type').notNull(),
    projectKey: text('project_key'),
    filterId: integer('filter_id'),
    /** Board estimation field (story points etc.); null when the board estimates by issue count. */
    estimationFieldId: text('estimation_field_id'),
    estimationFieldName: text('estimation_field_name'),
    columns: jsonb('columns').$type<BoardColumn[]>().notNull().default([]),
    /** Only selected boards are synced and get dashboards. */
    selected: boolean('selected').notNull().default(false),
    lastSyncedAt: ts('last_synced_at'),
    /** Per-board sync progress: one broken board must not hold back the others. */
    lastFullSyncAt: ts('last_full_sync_at'),
    /** Start of this board's last successful read (incremental reads start from it). */
    watermark: ts('watermark'),
    /** Code of this board's last failure (never a message); null once it syncs again. */
    lastError: text('last_error'),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('jira_boards_connection_board_uq').on(t.connectionId, t.jiraBoardId),
    index('jira_boards_org_idx').on(t.orgId),
    tenantPolicy('jira_boards', t.orgId),
  ],
);

export const jiraStatusMappings = pgTable(
  'jira_status_mappings',
  {
    orgId: text('org_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    jiraStatusId: text('jira_status_id').notNull(),
    statusName: text('status_name').notNull(),
    /** Jira's own status category key: new | indeterminate | done | undefined. */
    jiraCategory: text('jira_category').notNull(),
    category: statusCategory('category').notNull(),
    /** Waiting/blocked statuses count as wait time in flow efficiency. */
    blocked: boolean('blocked').notNull().default(false),
    source: statusMappingSource('source').notNull().default('auto'),
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.jiraStatusId] }),
    tenantPolicy('jira_status_mappings', t.orgId),
  ],
);

export const jiraSyncStates = pgTable(
  'jira_sync_states',
  {
    connectionId: uuid('connection_id')
      .primaryKey()
      .references(() => jiraConnections.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    status: syncStatus('status').notNull().default('idle'),
    /** Start time (our clock) of the last successful sync: the next incremental sync starts here. */
    watermark: ts('watermark'),
    lastFullSyncAt: ts('last_full_sync_at'),
    lastStartedAt: ts('last_started_at'),
    lastFinishedAt: ts('last_finished_at'),
    lastSuccessAt: ts('last_success_at'),
    /** A stable failure code (never raw error text, which could carry secrets). */
    lastError: text('last_error'),
    /**
     * The run that holds the lease. Every write of a run is fenced on it, so a run whose lease
     * was taken over (a stalled worker) can no longer write next to the new one.
     */
    leaseRunId: uuid('lease_run_id'),
    updatedAt,
  },
  (t) => [tenantPolicy('jira_sync_states', t.orgId)],
);

export const jiraSyncRuns = pgTable(
  'jira_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    trigger: syncTrigger('trigger').notNull(),
    mode: syncMode('mode').notNull(),
    status: syncStatus('status').notNull().default('running'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    boardsSynced: integer('boards_synced').notNull().default(0),
    issuesUpserted: integer('issues_upserted').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('jira_sync_runs_connection_started_idx').on(t.connectionId, t.startedAt),
    tenantPolicy('jira_sync_runs', t.orgId),
  ],
);

export const jiraIssues = pgTable(
  'jira_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    jiraIssueId: text('jira_issue_id').notNull(),
    key: text('key').notNull(),
    summary: text('summary').notNull(),
    issueType: text('issue_type').notNull(),
    isSubtask: boolean('is_subtask').notNull().default(false),
    statusId: text('status_id').notNull(),
    assigneeId: text('assignee_id'),
    assigneeName: text('assignee_name'),
    estimate: doublePrecision('estimate'),
    jiraCreatedAt: ts('jira_created_at').notNull(),
    jiraUpdatedAt: ts('jira_updated_at').notNull(),
    resolvedAt: ts('resolved_at'),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    components: text('components').array().notNull().default(sql`'{}'::text[]`),
    fixVersions: text('fix_versions').array().notNull().default(sql`'{}'::text[]`),
    priority: text('priority'),
    epicKey: text('epic_key'),
    epicName: text('epic_name'),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jira_issues_connection_issue_uq').on(t.connectionId, t.jiraIssueId),
    index('jira_issues_org_idx').on(t.orgId),
    tenantPolicy('jira_issues', t.orgId),
  ],
);

export const jiraBoardIssues = pgTable(
  'jira_board_issues',
  {
    orgId: text('org_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.issueId] }),
    index('jira_board_issues_issue_idx').on(t.issueId),
    tenantPolicy('jira_board_issues', t.orgId),
  ],
);

/** Status changes from the issue changelog, in changelog order (seq). */
export const jiraIssueTransitions = pgTable(
  'jira_issue_transitions',
  {
    orgId: text('org_id').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: ts('at').notNull(),
    fromStatusId: text('from_status_id'),
    toStatusId: text('to_status_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.seq] }),
    tenantPolicy('jira_issue_transitions', t.orgId),
  ],
);

/** Estimate and flag changes from the changelog (estimate values as text, flags as 'on'/'off'). */
export const jiraIssueChanges = pgTable(
  'jira_issue_changes',
  {
    orgId: text('org_id').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: ts('at').notNull(),
    kind: jiraIssueChangeKind('kind').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.seq] }), tenantPolicy('jira_issue_changes', t.orgId)],
);

export const jiraSprints = pgTable(
  'jira_sprints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    jiraSprintId: integer('jira_sprint_id').notNull(),
    name: text('name').notNull(),
    state: jiraSprintState('state').notNull(),
    startAt: ts('start_at'),
    endAt: ts('end_at'),
    completeAt: ts('complete_at'),
    goal: text('goal'),
    originBoardJiraId: integer('origin_board_jira_id'),
  },
  (t) => [
    uniqueIndex('jira_sprints_connection_sprint_uq').on(t.connectionId, t.jiraSprintId),
    tenantPolicy('jira_sprints', t.orgId),
  ],
);

export const jiraBoardSprints = pgTable(
  'jira_board_sprints',
  {
    orgId: text('org_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    sprintId: uuid('sprint_id')
      .notNull()
      .references(() => jiraSprints.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.sprintId] }),
    index('jira_board_sprints_sprint_idx').on(t.sprintId),
    tenantPolicy('jira_board_sprints', t.orgId),
  ],
);

/**
 * When an issue was in a sprint, derived from the Sprint field's changelog. Keyed by the Jira sprint
 * id, so membership of sprints from boards we don't sync is kept without a dangling reference.
 */
export const jiraSprintIssues = pgTable(
  'jira_sprint_issues',
  {
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
    jiraSprintId: integer('jira_sprint_id').notNull(),
    addedAt: ts('added_at').notNull(),
    removedAt: ts('removed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.jiraSprintId, t.addedAt] }),
    index('jira_sprint_issues_sprint_idx').on(t.connectionId, t.jiraSprintId),
    tenantPolicy('jira_sprint_issues', t.orgId),
  ],
);
