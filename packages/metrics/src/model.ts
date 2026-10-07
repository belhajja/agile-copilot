/** Board-agnostic workflow bucket every Jira status is mapped to. */
export type StatusCategory = 'todo' | 'in_progress' | 'done';

/** The issue sat in `category` from `from` until the next period starts. */
export interface StatusPeriod {
  from: Date;
  category: StatusCategory;
  /** The mapped status is a waiting/blocked state (counts as wait time in flow efficiency). */
  blocked: boolean;
}

export interface Interval {
  from: Date;
  /** null = still open */
  to: Date | null;
}

export interface EstimateChange {
  at: Date;
  from: number | null;
  to: number | null;
}

export interface MetricIssue {
  id: string;
  key: string;
  summary: string;
  type: string;
  createdAt: Date;
  updatedAt: Date;
  assignee: string | null;
  /** Current estimate (story points or the board's estimation field); null = not estimated. */
  estimate: number | null;
  /** Ascending. Used to know the estimate at sprint start/end. */
  estimateChanges: EstimateChange[];
  /** Ascending, non-empty; the first period starts at createdAt. */
  statusPeriods: StatusPeriod[];
  /** Times the issue was flagged (Jira "Impediment"). */
  flagged: Interval[];
  /** Current Jira status name. Optional fields: older fixtures and boards without them. */
  status?: string;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  priority?: string | null;
  epicKey?: string | null;
  epicName?: string | null;
}

export interface SprintMember {
  issueId: string;
  addedAt: Date;
  removedAt: Date | null;
}

export interface MetricSprint {
  id: string;
  name: string;
  state: 'future' | 'active' | 'closed';
  startAt: Date | null;
  endAt: Date | null;
  completeAt: Date | null;
  /** Jira's own sprint number (what Jira and the assistant's tools show). */
  jiraSprintId?: number;
  members: SprintMember[];
}

export interface BoardDataset {
  issues: MetricIssue[];
  sprints: MetricSprint[];
  /** The board has an estimation field (story points); false for count-based boards. */
  hasEstimates: boolean;
  /** False until the board's first full sync since labels, epics… were added to the sync. */
  fieldsSynced?: boolean;
}

export type Unit = 'points' | 'issues';
