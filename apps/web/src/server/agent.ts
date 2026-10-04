import 'server-only';
import type { AgentDeps } from '@agile/agent';
import { services } from './context';
import { syncDeps } from './sync';

/**
 * Dependencies of the agent: the sync's (Jira credentials, OAuth refresh, and the private-host
 * allowlist that makes openai_compatible models use the DNS-pinned fetch) + mcp-atlassian.
 */
export function agentDeps(): AgentDeps {
  const { onError: _syncLog, ...sync } = syncDeps();
  return {
    ...sync,
    // Code and error name only: messages, causes and tool data can carry provider bodies, Jira
    // content or secrets (a JiraToolError carries user candidates).
    onError: (error, code) =>
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'agent_error',
          code,
          name: error instanceof Error ? error.name : undefined,
        }),
      ),
    // Deployment-trusted: credentials are sent to this URL and it is not checked against the
    // outbound policy. It must point at the internal compose service only, never a tenant value.
    mcpAtlassianUrl: services().env.MCP_ATLASSIAN_URL,
  };
}
