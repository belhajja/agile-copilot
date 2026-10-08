// Lenient schemas for the Jira responses the sync reads. Only the fields we use are declared;
// everything else passes through, so a field Atlassian adds or drops elsewhere never breaks a sync.
import { z } from 'zod';
import { parseJiraDate } from './issue-normalize';
import type {
  JiraBoardConfig,
  JiraBoardInfo,
  JiraFieldInfo,
  JiraSprintInfo,
  JiraStatusInfo,
  RawChangelogHistory,
  RawChangelogItem,
  RawIssue,
} from './sync-types';

/** Reads only own string properties of Jira's raw item (see RawChangelogItem). */
function toItem(raw: Record<string, unknown>): RawChangelogItem {
  const own = (key: string) => {
    const value = Object.hasOwn(raw, key) ? raw[key] : null;
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return {
    field: own('field'),
    fieldId: own('fieldId'),
    from: own('from'),
    fromText: own('fromString'),
    to: own('to'),
    toText: own('toString'),
  };
}

export const historySchema = z
  .looseObject({
    id: z.union([z.string(), z.number()]).optional(),
    created: z.string(),
    // Plain records: a declared `toString` key would match the inherited method on every item.
    items: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .transform(
    (h): RawChangelogHistory => ({
      id: h.id === undefined ? undefined : String(h.id),
      created: h.created,
      items: h.items.map(toItem),
    }),
  );

const rawIssueSchema = z
  .looseObject({
    id: z.union([z.string(), z.number()]),
    key: z.string(),
    fields: z.record(z.string(), z.unknown()),
    changelog: z
      .looseObject({ total: z.number().optional(), histories: z.array(historySchema).default([]) })
      .optional(),
  })
  .transform(
    (i): RawIssue => ({ id: String(i.id), key: i.key, fields: i.fields, changelog: i.changelog }),
  );

const pageFields = {
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
};

export const boardPageSchema = z.looseObject({
  ...pageFields,
  values: z
    .array(
      z.looseObject({
        id: z.number(),
        name: z.string(),
        type: z.string(),
        location: z.looseObject({ projectKey: z.string().optional() }).nullish(),
      }),
    )
    .default([]),
});

export const toBoardInfo = (
  b: z.infer<typeof boardPageSchema>['values'][number],
): JiraBoardInfo => ({
  jiraBoardId: b.id,
  name: b.name,
  type: b.type === 'scrum' || b.type === 'kanban' ? b.type : 'simple',
  projectKey: b.location?.projectKey ?? null,
});

export const boardConfigSchema = z
  .looseObject({
    filter: z.looseObject({ id: z.union([z.string(), z.number()]) }).nullish(),
    columnConfig: z
      .looseObject({
        columns: z
          .array(
            z.looseObject({
              name: z.string(),
              statuses: z
                .array(z.looseObject({ id: z.union([z.string(), z.number()]) }))
                .default([]),
            }),
          )
          .default([]),
      })
      .nullish(),
    estimation: z
      .looseObject({
        field: z.looseObject({ fieldId: z.string(), displayName: z.string().optional() }).nullish(),
      })
      .nullish(),
  })
  .transform(
    (c): JiraBoardConfig => ({
      filterId: c.filter ? Number(c.filter.id) : null,
      estimationFieldId: c.estimation?.field?.fieldId ?? null,
      estimationFieldName: c.estimation?.field?.displayName ?? null,
      columns: (c.columnConfig?.columns ?? []).map((col) => ({
        name: col.name,
        statusIds: col.statuses.map((s) => String(s.id)),
      })),
    }),
  );

export const sprintPageSchema = z.looseObject({
  ...pageFields,
  values: z
    .array(
      z
        .looseObject({
          id: z.number(),
          name: z.string(),
          state: z.string(),
          startDate: z.string().nullish(),
          endDate: z.string().nullish(),
          completeDate: z.string().nullish(),
          goal: z.string().nullish(),
          originBoardId: z.number().nullish(),
        })
        .transform(
          (s): JiraSprintInfo => ({
            jiraSprintId: s.id,
            name: s.name,
            state: s.state === 'active' || s.state === 'closed' ? s.state : 'future',
            startAt: parseJiraDate(s.startDate),
            endAt: parseJiraDate(s.endDate),
            completeAt: parseJiraDate(s.completeDate),
            goal: s.goal || null,
            originBoardJiraId: s.originBoardId ?? null,
          }),
        ),
    )
    .default([]),
});

const CATEGORY_KEYS = new Set(['new', 'indeterminate', 'done']);
export const statusListSchema = z.array(
  z
    .looseObject({
      id: z.union([z.string(), z.number()]),
      name: z.string(),
      statusCategory: z.looseObject({ key: z.string() }).nullish(),
    })
    .transform(
      (s): JiraStatusInfo => ({
        id: String(s.id),
        name: s.name,
        categoryKey: (CATEGORY_KEYS.has(s.statusCategory?.key ?? '')
          ? s.statusCategory?.key
          : 'undefined') as JiraStatusInfo['categoryKey'],
      }),
    ),
);

export const fieldListSchema = z.array(
  z
    .looseObject({
      id: z.string(),
      name: z.string(),
      schema: z.looseObject({ custom: z.string().optional() }).nullish(),
    })
    .transform(
      (f): JiraFieldInfo => ({ id: f.id, name: f.name, custom: f.schema?.custom ?? null }),
    ),
);

export const cloudSearchSchema = z.looseObject({
  issues: z.array(rawIssueSchema).default([]),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

export const dcSearchSchema = z.looseObject({
  ...pageFields,
  issues: z.array(rawIssueSchema).default([]),
});

export const changelogPageSchema = z.looseObject({
  ...pageFields,
  values: z.array(historySchema).default([]),
});

export const issueChangelogSchema = z.looseObject({
  changelog: z.looseObject({ histories: z.array(historySchema).default([]) }).nullish(),
});
