import type { JiraCredentials } from '@agile/jira';
import type { OutboundPolicy } from '@agile/net';
import type { JiraToolBackend } from './backend';
import { createMcpAtlassianBackend } from './mcp-backend';
import { createRestJiraBackend } from './rest-backend';

export {
  codeForStatus,
  exactPerson,
  type JiraToolBackend,
  JiraToolError,
  type JiraToolErrorCode,
  type JiraUserCandidate,
} from './backend';
export {
  ISSUE_KEY_PATTERN,
  isJiraToolName,
  isJiraWriteTool,
  JIRA_TOOL_NAMES,
  JIRA_TOOLS,
  JIRA_WRITE_TOOLS,
  type JiraToolInput,
  type JiraToolName,
  parseJiraToolInput,
} from './catalog';
export {
  createMcpAtlassianBackend,
  MCP_ATLASSIAN_BACKEND_ONLY_TOOLS,
  MCP_ATLASSIAN_ENABLED_TOOLS,
  MCP_ATLASSIAN_READONLY_ENABLED_TOOLS,
  type McpCredentials,
  mcpAtlassianHeaders,
} from './mcp-backend';
export { createRestJiraBackend } from './rest-backend';

/**
 * Picks how a connection's Jira tools run. Data Center PATs and Cloud OAuth go through the shared
 * mcp-atlassian instance (null when MCP_ATLASSIAN_URL is not configured); Cloud API tokens use the
 * built-in REST backend, because mcp-atlassian would need one instance per Cloud site for them.
 */
export function createJiraToolBackend(
  creds: JiraCredentials,
  opts: { mcpAtlassianUrl?: string; outbound: OutboundPolicy; timeoutMs?: number },
): JiraToolBackend | null {
  if (creds.kind === 'cloud_basic') {
    return createRestJiraBackend(creds, { outbound: opts.outbound, timeoutMs: opts.timeoutMs });
  }
  if (!opts.mcpAtlassianUrl) return null;
  return createMcpAtlassianBackend(creds, {
    url: opts.mcpAtlassianUrl,
    timeoutMs: opts.timeoutMs,
  });
}
