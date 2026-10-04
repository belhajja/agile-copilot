import { z } from 'zod';

// The only Jira tools the agent ever sees (mcp-atlassian exposes ~60). Inputs are our own narrow
// schemas, not mcp-atlassian's: no free-form JSON fields, no attachment paths, bounded sizes.
// `toMcp` maps an input to mcp-atlassian 0.23.1 arguments (pinned by the contract test);
// `fromMcp` is its inverse (used by the e2e double).

const issueKey = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/, 'An issue key such as PROJ-123')
  .describe('Issue key, e.g. PROJ-123');
const numericId = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,12}$/, `A numeric ${what} id`)
    .describe(`Numeric ${what} id`);
const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`At most ${max} results`);
const text = (max: number) => z.string().trim().min(1).max(max);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

interface ToolDef<S extends z.ZodObject> {
  /** Writes always need the user's approval. */
  write: boolean;
  description: string;
  input: S;
  toMcp(input: z.output<S>): Record<string, unknown>;
  fromMcp(args: Record<string, unknown>): z.input<S>;
}
const def = <S extends z.ZodObject>(d: ToolDef<S>) => d;

export const JIRA_TOOLS = {
  jira_search: def({
    write: false,
    description:
      'Search Jira issues with JQL (live data, may be newer than the synced dashboards). Returns key, summary, status, assignee.',
    input: z.object({ jql: text(2000).describe('JQL query'), limit: limit(50, 20) }),
    toMcp: (i) => ({ jql: i.jql, limit: i.limit }),
    fromMcp: (a) => ({ jql: str(a.jql) ?? '', limit: num(a.limit) }),
  }),
  jira_get_issue: def({
    write: false,
    description: 'Read one Jira issue: fields, status, assignee, description and latest comments.',
    input: z.object({
      issueKey,
      commentLimit: z.number().int().min(0).max(20).default(5).describe('Comments to include'),
    }),
    toMcp: (i) => ({ issue_key: i.issueKey, comment_limit: i.commentLimit }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '', commentLimit: num(a.comment_limit) }),
  }),
  jira_get_transitions: def({
    write: false,
    description: 'List the workflow transitions available for an issue (needed before moving it).',
    input: z.object({ issueKey }),
    toMcp: (i) => ({ issue_key: i.issueKey }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '' }),
  }),
  jira_get_agile_boards: def({
    write: false,
    description: 'List Jira agile boards, optionally for one project.',
    input: z.object({
      projectKey: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]{0,19}$/)
        .optional()
        .describe('Project key'),
    }),
    toMcp: (i) => (i.projectKey ? { project_key: i.projectKey } : {}),
    fromMcp: (a) => ({ projectKey: str(a.project_key) }),
  }),
  jira_get_sprints_from_board: def({
    write: false,
    description: 'List the sprints of a Jira board.',
    input: z.object({
      boardId: numericId('board'),
      state: z.enum(['active', 'future', 'closed']).optional(),
    }),
    toMcp: (i) => ({ board_id: i.boardId, ...(i.state ? { state: i.state } : {}) }),
    fromMcp: (a) => ({
      boardId: str(a.board_id) ?? '',
      state: str(a.state) as 'active' | 'future' | 'closed' | undefined,
    }),
  }),
  jira_get_sprint_issues: def({
    write: false,
    description: 'List the issues of a sprint.',
    input: z.object({ sprintId: numericId('sprint'), limit: limit(50, 50) }),
    toMcp: (i) => ({ sprint_id: i.sprintId, limit: i.limit }),
    fromMcp: (a) => ({ sprintId: str(a.sprint_id) ?? '', limit: num(a.limit) }),
  }),
  jira_add_comment: def({
    write: true,
    description: 'Add a comment to an issue. Needs the user’s approval.',
    input: z.object({ issueKey, body: text(5000).describe('Comment text (Markdown)') }),
    toMcp: (i) => ({ issue_key: i.issueKey, body: i.body }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '', body: str(a.body) ?? '' }),
  }),
  jira_transition_issue: def({
    write: true,
    description:
      'Move an issue through its workflow (call jira_get_transitions first for the id). Needs the user’s approval.',
    input: z.object({
      issueKey,
      transitionId: numericId('transition'),
      comment: text(5000).optional().describe('Optional comment'),
    }),
    toMcp: (i) => ({
      issue_key: i.issueKey,
      transition_id: i.transitionId,
      ...(i.comment ? { comment: i.comment } : {}),
    }),
    fromMcp: (a) => ({
      issueKey: str(a.issue_key) ?? '',
      transitionId: str(a.transition_id) ?? '',
      comment: str(a.comment),
    }),
  }),
  jira_assign_issue: def({
    write: true,
    description:
      'Assign an issue to a person (email, username or account id). Needs the user’s approval.',
    input: z.object({ issueKey, assignee: text(128).describe('Email, username or account id') }),
    /**
     * mcp-atlassian 0.23.1's argument names only (pinned by the catalog and contract tests). No
     * backend may send this raw string to mcp-atlassian: it would match it loosely (first search
     * hit, then any user with BROWSE permission) or parse a JSON object out of it. Backends resolve
     * the one exact person first and assign by id (ruling P3-R17); see `createMcpAtlassianBackend`.
     */
    toMcp: (i) => ({ issue_key: i.issueKey, assignee: i.assignee }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '', assignee: str(a.assignee) ?? '' }),
  }),
  jira_create_issue: def({
    write: true,
    description: 'Create an issue. Needs the user’s approval.',
    input: z.object({
      projectKey: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]{0,19}$/)
        .describe('Project key'),
      summary: text(255),
      issueType: text(64).describe('Issue type name, e.g. Task, Bug, Story'),
      description: text(10_000).optional(),
    }),
    toMcp: (i) => ({
      project_key: i.projectKey,
      summary: i.summary,
      issue_type: i.issueType,
      ...(i.description ? { description: i.description } : {}),
    }),
    fromMcp: (a) => ({
      projectKey: str(a.project_key) ?? '',
      summary: str(a.summary) ?? '',
      issueType: str(a.issue_type) ?? '',
      description: str(a.description),
    }),
  }),
  jira_update_issue: def({
    write: true,
    description:
      'Change the summary, description or labels of an issue. Needs the user’s approval.',
    input: z
      .object({
        issueKey,
        summary: text(255).optional(),
        description: text(10_000).optional(),
        labels: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[^\s]{1,64}$/),
          )
          .min(1)
          .max(20)
          .optional()
          .describe('The complete new label list (replaces the current labels; cannot be empty)'),
      })
      .refine((i) => i.summary ?? i.description ?? i.labels, 'Change at least one field'),
    toMcp: (i) => ({
      issue_key: i.issueKey,
      fields: JSON.stringify({
        ...(i.summary ? { summary: i.summary } : {}),
        ...(i.description ? { description: i.description } : {}),
        ...(i.labels ? { labels: i.labels } : {}),
      }),
    }),
    fromMcp: (a) => {
      let fields: Record<string, unknown> = {};
      try {
        fields = JSON.parse(str(a.fields) ?? '{}') as Record<string, unknown>;
      } catch {}
      return {
        issueKey: str(a.issue_key) ?? '',
        summary: str(fields.summary),
        description: str(fields.description),
        labels: Array.isArray(fields.labels)
          ? fields.labels.filter((l) => typeof l === 'string')
          : undefined,
      };
    },
  }),
} as const;

export type JiraToolName = keyof typeof JIRA_TOOLS;
export type JiraToolInput<N extends JiraToolName> = z.output<(typeof JIRA_TOOLS)[N]['input']>;
export const JIRA_TOOL_NAMES: readonly JiraToolName[] = Object.freeze(
  Object.keys(JIRA_TOOLS) as JiraToolName[],
);
/**
 * The tools that change Jira (they always need the user's approval). This module imports only zod,
 * so the browser can use it too.
 */
export const JIRA_WRITE_TOOLS: ReadonlySet<JiraToolName> = new Set(
  JIRA_TOOL_NAMES.filter((n) => JIRA_TOOLS[n].write),
);
/** Own keys only: `toString` or `constructor` are not tools. */
export const isJiraToolName = (name: string): name is JiraToolName =>
  Object.hasOwn(JIRA_TOOLS, name);
export const isJiraWriteTool = (name: string): boolean =>
  isJiraToolName(name) && JIRA_WRITE_TOOLS.has(name);

/** Validates model input for a tool (never trust the model's JSON). */
export function parseJiraToolInput<N extends JiraToolName>(name: N, input: unknown) {
  return JIRA_TOOLS[name].input.safeParse(input) as z.ZodSafeParseResult<JiraToolInput<N>>;
}
