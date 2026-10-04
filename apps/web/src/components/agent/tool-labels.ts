import { allowedCode } from '@/lib/error-code';

/**
 * Tool names with a translated label (`agent.tools.*`). Tool names come from the model (an invalid
 * call keeps the name it made up), so labels are looked up in this list, never with `t.has`.
 * A test ties it to the messages and to the agent's tools.
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
  'load_skill',
  'pin_widget',
] as const;

/** The translated label of a tool, or its name as is when it has none. */
export function toolLabel(
  t: (key: `tools.${(typeof TOOL_LABELS)[number]}`) => string,
  name: string,
) {
  const known = allowedCode(name, TOOL_LABELS);
  return known ? t(`tools.${known}`) : name;
}
