import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jiraBoards } from './jira-data';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

export const dashboardKind = pgEnum('dashboard_kind', ['scrum', 'kanban', 'custom']);

/** One user's dashboard for one board. `widgets` holds zod-validated WidgetSpec objects (@agile/dashboards). */
export const dashboards = pgTable(
  'dashboards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: dashboardKind('kind').notNull(),
    position: integer('position').notNull().default(0),
    widgets: jsonb('widgets').$type<unknown[]>().notNull().default([]),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('dashboards_board_idx').on(t.boardId),
    index('dashboards_owner_idx').on(t.orgId, t.userId, t.boardId),
    // At most one default dashboard of each kind per user and board (makes seeding idempotent).
    uniqueIndex('dashboards_default_uq')
      .on(t.boardId, t.userId, t.kind)
      .where(sql`${t.kind} <> 'custom'`),
    tenantPolicy('dashboards', t.orgId),
  ],
);
