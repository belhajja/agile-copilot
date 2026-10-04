import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

export const skillTrigger = pgEnum('skill_trigger', ['on_demand', 'always', 'schedule', 'alert']);
export const skillOutput = pgEnum('skill_output', [
  'chat',
  'dashboard_card',
  'email',
  'slack',
  'teams',
]);
export const skillVisibility = pgEnum('skill_visibility', ['private', 'workspace']);
export const skillRunTrigger = pgEnum('skill_run_trigger', ['schedule', 'alert', 'manual']);
export const skillRunStatus = pgEnum('skill_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
]);
export const deliveryChannelKind = pgEnum('delivery_channel_kind', ['smtp', 'slack', 'teams']);

/**
 * A skill (SKILL.md). Owned by one member; `workspace` visibility lets other members read and
 * fork it, never edit it. `name`, `description`, `trigger`, `output` mirror the current version's
 * frontmatter for listing and scheduling; the document itself lives in `skill_versions`.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    trigger: skillTrigger('trigger').notNull(),
    output: skillOutput('output').notNull(),
    visibility: skillVisibility('visibility').notNull().default('private'),
    enabled: boolean('enabled').notNull().default(true),
    /** UI language of the owner's last save ('en' | 'fr'): the fixed wording of emails and posts. */
    locale: text('locale').notNull().default('en'),
    currentVersion: integer('current_version').notNull().default(1),
    /** The built-in template it was copied from (null for skills written from scratch). */
    builtinKey: text('builtin_key'),
    /**
     * The skill it was forked from. No foreign key: deleting the original must not delete forks
     * (and the tenant guard only allows cascading foreign keys, plus `skill_runs.channel_id`).
     */
    forkedFromId: uuid('forked_from_id'),
    forkedFromVersion: integer('forked_from_version'),
    /** Slack/Teams channel for those outputs. No foreign key: deleting a channel keeps the skill. */
    channelId: uuid('channel_id'),
    /**
     * Schedules: the later of the last scheduled time handled and the time the schedule was saved.
     * The tick only runs scheduled times after it, so each runs once and never retroactively.
     */
    scheduleCursor: timestamp('schedule_cursor', { withTimezone: true }),
    /** Alerts: boards whose condition held at the last evaluation (edge detection). */
    alertBoards: jsonb('alert_boards').$type<string[]>().notNull().default([]),
    alertFiredAt: timestamp('alert_fired_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('skills_owner_name_uq').on(t.orgId, t.ownerUserId, t.name),
    index('skills_org_trigger_idx').on(t.orgId, t.trigger),
    tenantPolicy('skills', t.orgId),
  ],
);

/** Every saved version of a skill's SKILL.md, append-only (restore = save an old one again). */
export const skillVersions = pgTable(
  'skill_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    document: text('document').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt,
  },
  (t) => [
    uniqueIndex('skill_versions_skill_version_uq').on(t.skillId, t.version),
    tenantPolicy('skill_versions', t.orgId),
  ],
);

/**
 * One background run of a skill (schedule, alert or "Run now"). Scheduled runs are unique per
 * scheduled time, so two ticks never run the same occurrence twice.
 */
export const skillRuns = pgTable(
  'skill_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    trigger: skillRunTrigger('trigger').notNull(),
    status: skillRunStatus('status').notNull().default('queued'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    /** Stable outcome code (never raw error text), also the skip reason (e.g. `owner_left`). */
    resultCode: text('result_code'),
    /** The model's report (Markdown). */
    output: text('output'),
    /** Alerts: the boards and values that fired the run. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    /** Snapshot at plan/request time of the skill's output kind: delivery uses it, not later edits. */
    outputKind: skillOutput('output_kind'),
    /**
     * Snapshot of the skill's channel at plan/request time (P4-R5). Deleting the channel clears it
     * (SET NULL, the one tenant FK that does not cascade: the run and its report outlive the channel).
     */
    channelId: uuid('channel_id').references(() => deliveryChannels.id, { onDelete: 'set null' }),
    /** Delivery outcome per output: { email: 'sent' | '<code>', slack: …, teams: … }. */
    deliveries: jsonb('deliveries').$type<Record<string, string>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex('skill_runs_skill_scheduled_uq').on(t.skillId, t.scheduledFor),
    index('skill_runs_skill_created_idx').on(t.skillId, t.createdAt),
    index('skill_runs_channel_idx').on(t.channelId),
    index('skill_runs_org_created_idx').on(t.orgId, t.createdAt),
    tenantPolicy('skill_runs', t.orgId),
  ],
);

/**
 * Where skill outputs go: the workspace's SMTP server or a Slack/Teams incoming webhook. The URL,
 * credentials and sender live only in `secret` (envelope-encrypted, bound to the row id); `hint`
 * is a non-secret label for the UI (host name).
 */
export const deliveryChannels = pgTable(
  'delivery_channels',
  {
    // App-generated so the secret can be encrypted bound to this id before insert.
    id: uuid('id').primaryKey(),
    orgId: text('org_id').notNull(),
    kind: deliveryChannelKind('kind').notNull(),
    name: text('name').notNull(),
    hint: text('hint').notNull(),
    secret: text('secret').notNull(),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('delivery_channels_org_name_uq').on(t.orgId, t.name),
    // Email goes through the workspace's one SMTP server.
    uniqueIndex('delivery_channels_one_smtp_uq').on(t.orgId).where(sql`${t.kind} = 'smtp'`),
    tenantPolicy('delivery_channels', t.orgId),
  ],
);
