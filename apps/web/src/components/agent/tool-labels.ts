import { allowedCode } from '@/lib/error-code';

/**
 * Tool names with a translated label (`agent.tools.*`). Tool names come from the model (an invalid
 * call keeps the name it made up), so labels are looked up in this list, never with `t.has`.
 * A test ties it to the `agent.tools` messages (EN and FR); a tool without a label is shown by name.
 */
export const TOOL_LABELS = [
  'list_boards',
  'list_metrics',
  'get_metric',
  'forecast',
  'find_issues',
  'explain_metric',
  'jira_search',
  'jira_get_issue',
  'jira_get_transitions',
  'jira_get_agile_boards',
  'jira_get_sprints_from_board',
  'jira_get_sprint_issues',
  'jira_add_comment',
  'jira_transition_issue',
  'jira_assign_issue',
  'jira_create_issue',
  'jira_update_issue',
  'jira_get_worklog',
  'jira_worklog_summary',
  'jira_get_board_issues',
  'jira_get_issue_dates',
  'jira_get_project_epic_hierarchy',
  'jira_get_cross_project_dependencies',
  'jira_get_link_types',
  'jira_get_project_versions',
  'jira_get_project_components',
  'jira_search_fields',
  'jira_get_issue_watchers',
  'load_skill',
  'pin_widget',
  'suggest_skill',
] as const;

/** The translated label of a tool, or its name as is when it has none. */
export function toolLabel(
  t: (key: `tools.${(typeof TOOL_LABELS)[number]}`) => string,
  name: string,
) {
  const known = allowedCode(name, TOOL_LABELS);
  return known ? t(`tools.${known}`) : name;
}
