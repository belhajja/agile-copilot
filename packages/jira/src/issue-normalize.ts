import { z } from 'zod';
import { parseGreenhopperSprint } from './sprint-field';
import type {
  IssueFieldContext,
  JiraFieldInfo,
  JiraStatusInfo,
  NormalizedIssue,
  RawChangelogHistory,
  RawChangelogItem,
  RawIssue,
} from './sync-types';

/** Jira timestamps look like 2026-10-03T10:00:00.000+0200; null when missing or unparseable. */
export function parseJiraDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const iso = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Sprint ids from the Sprint field. Cloud (and recent DC) return objects with `id`; older Data
 * Center returns strings like "com.atlassian.greenhopper.service.sprint.Sprint@1a[id=12,...]".
 */
export function parseSprintField(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.flatMap((v) => {
    if (typeof v === 'object' && v !== null && 'id' in v) {
      const id = Number((v as { id: unknown }).id);
      return Number.isInteger(id) ? [id] : [];
    }
    if (typeof v === 'string') {
      const sprint = parseGreenhopperSprint(v);
      return sprint ? [sprint.id] : [];
    }
    return [];
  });
  return [...new Set(ids)];
}

/** Sprint ids in a changelog value such as "12, 13". */
const parseSprintIds = (value: string | null | undefined): number[] => [
  ...new Set((value ?? '').match(/\d+/g)?.map(Number) ?? []),
];

/**
 * Turns the Sprint field's history into membership intervals. The set before the first change is
 * that change's `from` (the issue was created in those sprints); with no changes it is the
 * current value. Each change replaces the set with its `to`.
 */
export function deriveSprintMembership(
  createdAt: Date,
  current: number[],
  changes: { at: Date; from: number[]; to: number[] }[],
): NormalizedIssue['sprintMembership'] {
  const result: NormalizedIssue['sprintMembership'] = [];
  const open = new Map<number, Date>();
  for (const id of changes[0]?.from ?? current) open.set(id, createdAt);
  for (const change of changes) {
    const next = new Set(change.to);
    for (const [id, since] of open) {
      if (!next.has(id)) {
        result.push({ jiraSprintId: id, addedAt: since, removedAt: change.at });
        open.delete(id);
      }
    }
    for (const id of next) if (!open.has(id)) open.set(id, change.at);
  }
  for (const [id, since] of open)
    result.push({ jiraSprintId: id, addedAt: since, removedAt: null });
  return result.sort(
    (a, b) => a.jiraSprintId - b.jiraSprintId || a.addedAt.getTime() - b.addedAt.getTime(),
  );
}

const userSchema = z
  .looseObject({
    accountId: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().optional(),
  })
  .nullish();

const named = z
  .array(z.looseObject({ name: z.string() }))
  .nullish()
  .catch(null);

const fieldsSchema = z.looseObject({
  summary: z.string().nullish(),
  issuetype: z.looseObject({ name: z.string(), subtask: z.boolean().optional() }).nullish(),
  status: z.looseObject({ id: z.string() }),
  assignee: userSchema,
  created: z.string(),
  updated: z.string(),
  resolutiondate: z.string().nullish(),
  labels: z.array(z.string()).nullish().catch(null),
  priority: z.looseObject({ name: z.string() }).nullish().catch(null),
  components: named,
  fixVersions: named,
  parent: z
    .looseObject({
      key: z.string(),
      fields: z
        .looseObject({
          summary: z.string().nullish(),
          issuetype: z
            .looseObject({ name: z.string().nullish(), hierarchyLevel: z.number().nullish() })
            .nullish(),
        })
        .nullish(),
    })
    .nullish()
    .catch(null),
});

const isStatus = (i: RawChangelogItem) => i.fieldId === 'status' || i.field === 'status';
const isSprint = (i: RawChangelogItem) => i.field === 'Sprint';
const isFlag = (i: RawChangelogItem) => i.field === 'Flagged';
const flagValue = (v: string | null) => (v && v.trim() !== '' ? 'on' : 'off');

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Distinct, trimmed, non-empty values, in Jira's order. */
const distinct = (values: readonly (string | null | undefined)[] | null | undefined): string[] => [
  ...new Set((values ?? []).map((v) => v?.trim() ?? '').filter((v) => v !== '')),
];

type ParentField = z.infer<typeof fieldsSchema>['parent'];

/** The issue's epic: Data Center's Epic Link (a key), else a Cloud parent that is an epic. */
function epicOf(
  raw: RawIssue,
  parent: ParentField,
  epicLinkFieldId: string | null | undefined,
): { epicKey: string | null; epicName: string | null } {
  const link = epicLinkFieldId ? raw.fields[epicLinkFieldId] : null;
  if (typeof link === 'string' && link.trim() !== '')
    return { epicKey: link.trim(), epicName: null };
  const type = parent?.fields?.issuetype;
  if (parent && (type?.name === 'Epic' || type?.hierarchyLevel === 1)) {
    return { epicKey: parent.key, epicName: parent.fields?.summary?.trim() || null };
  }
  return { epicKey: null, epicName: null };
}

/** Oldest first; ties keep Jira's id order. */
function sortHistories(histories: RawChangelogHistory[]): RawChangelogHistory[] {
  return [...histories]
    .map((h) => ({ h, at: parseJiraDate(h.created)?.getTime() ?? 0, id: Number(h.id ?? 0) }))
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .map((x) => x.h);
}

/** Reduces a raw issue plus its complete changelog to what the metrics need. */
export function normalizeIssue(
  raw: RawIssue,
  histories: RawChangelogHistory[],
  ctx: IssueFieldContext,
): NormalizedIssue {
  const f = fieldsSchema.parse(raw.fields);
  const createdAt = parseJiraDate(f.created);
  const updatedAt = parseJiraDate(f.updated);
  if (!createdAt || !updatedAt) throw new TypeError(`Issue ${raw.key} has unreadable dates`);

  const isEstimate = (i: RawChangelogItem) =>
    (ctx.estimationFieldId !== null && i.fieldId === ctx.estimationFieldId) ||
    (ctx.estimationFieldName !== null && i.field === ctx.estimationFieldName);

  const transitions: NormalizedIssue['transitions'] = [];
  const changes: NormalizedIssue['changes'] = [];
  const sprintChanges: { at: Date; from: number[]; to: number[] }[] = [];
  let seq = 0;
  for (const history of sortHistories(histories)) {
    const at = parseJiraDate(history.created);
    if (!at) continue;
    for (const item of history.items) {
      if (isStatus(item) && item.to) {
        transitions.push({ seq: seq++, at, fromStatusId: item.from, toStatusId: item.to });
      } else if (isSprint(item)) {
        sprintChanges.push({ at, from: parseSprintIds(item.from), to: parseSprintIds(item.to) });
      } else if (isFlag(item)) {
        changes.push({
          seq: seq++,
          at,
          kind: 'flag',
          fromValue: flagValue(item.fromText ?? item.from),
          toValue: flagValue(item.toText ?? item.to),
        });
      } else if (isEstimate(item)) {
        changes.push({
          seq: seq++,
          at,
          kind: 'estimate',
          fromValue: item.fromText ?? item.from,
          toValue: item.toText ?? item.to,
        });
      }
    }
  }

  const assignee = f.assignee ?? null;
  return {
    jiraIssueId: raw.id,
    key: raw.key,
    summary: f.summary ?? '',
    issueType: f.issuetype?.name ?? 'Issue',
    isSubtask: f.issuetype?.subtask ?? false,
    statusId: f.status.id,
    assigneeId: assignee ? (assignee.accountId ?? assignee.key ?? assignee.name ?? null) : null,
    assigneeName: assignee?.displayName ?? null,
    estimate: ctx.estimationFieldId ? toNumber(raw.fields[ctx.estimationFieldId]) : null,
    createdAt,
    updatedAt,
    resolvedAt: parseJiraDate(f.resolutiondate),
    labels: distinct(f.labels),
    components: distinct(f.components?.map((c) => c.name)),
    fixVersions: distinct(f.fixVersions?.map((v) => v.name)),
    priority: f.priority?.name.trim() || null,
    ...epicOf(raw, f.parent, ctx.epicLinkFieldId),
    transitions,
    changes,
    sprintMembership: deriveSprintMembership(
      createdAt,
      ctx.sprintFieldId ? parseSprintField(raw.fields[ctx.sprintFieldId]) : [],
      sprintChanges,
    ),
  };
}

/** The Sprint custom field (Jira Software), if the site has one. */
export const findSprintField = (fields: JiraFieldInfo[]): string | null =>
  fields.find((f) => f.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id ?? null;

/** Data Center's Epic Link custom field (Jira Software), if the site has one. */
export const findEpicLinkField = (fields: JiraFieldInfo[]): string | null =>
  fields.find((f) => f.custom === 'com.pyxis.greenhopper.jira:gh-epic-link')?.id ?? null;

/** Fields to request from search so normalizeIssue has everything it reads. */
export const issueFieldList = (ctx: IssueFieldContext): string[] =>
  [
    'summary',
    'issuetype',
    'status',
    'assignee',
    'created',
    'updated',
    'resolutiondate',
    'labels',
    'priority',
    'components',
    'fixVersions',
    'parent',
    ctx.estimationFieldId,
    ctx.sprintFieldId,
    ctx.epicLinkFieldId,
  ].filter((f): f is string => Boolean(f));

const BLOCKED_NAME = /block|imped|on hold|waiting/i;

/** Default mapping from Jira's status category; "blocked"-sounding in-progress statuses are waits. */
export function suggestStatusMapping(status: JiraStatusInfo): {
  category: 'todo' | 'in_progress' | 'done';
  blocked: boolean;
} {
  if (status.categoryKey === 'new') return { category: 'todo', blocked: false };
  if (status.categoryKey === 'done') return { category: 'done', blocked: false };
  return { category: 'in_progress', blocked: BLOCKED_NAME.test(status.name) };
}

/** Minutes of overlap re-read on every incremental sync (clock skew, slow indexing). */
export const SYNC_OVERLAP_MINUTES = 15;

/**
 * JQL for a board's issues, oldest first. Incremental syncs use a RELATIVE date ("-75m"): absolute
 * JQL dates are read in the Jira user's time zone, which would shift the window by hours.
 */
export function buildIssueJql(filterId: number, since: Date | null, now: Date): string {
  const base = `filter = ${Math.trunc(filterId)}`;
  if (!since) return `${base} ORDER BY created ASC`;
  const minutes =
    Math.max(0, Math.ceil((now.getTime() - since.getTime()) / 60_000)) + SYNC_OVERLAP_MINUTES;
  return `${base} AND updated >= "-${minutes}m" ORDER BY created ASC`;
}
