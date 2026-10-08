export type JiraBoardType = 'scrum' | 'kanban' | 'simple';
type JiraStatusCategoryKey = 'new' | 'indeterminate' | 'done' | 'undefined';

export interface JiraBoardInfo {
  jiraBoardId: number;
  name: string;
  type: JiraBoardType;
  projectKey: string | null;
}

export interface JiraBoardConfig {
  filterId: number | null;
  estimationFieldId: string | null;
  estimationFieldName: string | null;
  columns: { name: string; statusIds: string[] }[];
}

export interface JiraStatusInfo {
  id: string;
  name: string;
  categoryKey: JiraStatusCategoryKey;
}

export interface JiraFieldInfo {
  id: string;
  name: string;
  /** schema.custom, e.g. com.pyxis.greenhopper.jira:gh-sprint; null for system fields. */
  custom: string | null;
}

export interface JiraSprintInfo {
  jiraSprintId: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startAt: Date | null;
  endAt: Date | null;
  completeAt: Date | null;
  goal: string | null;
  originBoardJiraId: number | null;
}

/**
 * One changelog item. Jira's `fromString`/`toString` are renamed `fromText`/`toText`: a property
 * read as `item.toString` returns Object.prototype.toString whenever Jira omits the key.
 */
export interface RawChangelogItem {
  field: string | null;
  fieldId: string | null;
  from: string | null;
  fromText: string | null;
  to: string | null;
  toText: string | null;
}

export interface RawChangelogHistory {
  id?: string;
  created: string;
  items: RawChangelogItem[];
}

/** An issue as Jira returns it from search (fields untyped: they depend on the site). */
export interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  changelog?: { total?: number; histories: RawChangelogHistory[] };
}

export interface NormalizedIssue {
  jiraIssueId: string;
  key: string;
  summary: string;
  issueType: string;
  isSubtask: boolean;
  statusId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  estimate: number | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  /** Distinct, trimmed; [] when Jira has none. */
  labels: string[];
  components: string[];
  fixVersions: string[];
  priority: string | null;
  /** Data Center: the Epic Link value; Cloud: the parent when it is an epic. */
  epicKey: string | null;
  /** Cloud: the parent's summary; Data Center: filled after the sync looks the epics up. */
  epicName: string | null;
  transitions: { seq: number; at: Date; fromStatusId: string | null; toStatusId: string }[];
  changes: {
    seq: number;
    at: Date;
    kind: 'estimate' | 'flag';
    fromValue: string | null;
    toValue: string | null;
  }[];
  sprintMembership: { jiraSprintId: number; addedAt: Date; removedAt: Date | null }[];
}

/** Site-specific field ids needed to read an issue. */
export interface IssueFieldContext {
  estimationFieldId: string | null;
  estimationFieldName: string | null;
  sprintFieldId: string | null;
  /** Data Center's Epic Link custom field, when the site has one. */
  epicLinkFieldId?: string | null;
}
