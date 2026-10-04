import 'server-only';
import type { McpHttpDeps } from '@agile/mcp-gateway';
import { entitlements } from './billing';
import { services } from './context';

/** External MCP: tokens checked against the workspace's plan (always allowed in self-host). */
export function mcpDeps(): McpHttpDeps {
  const { db, env } = services();
  return {
    db,
    planAllowsMcp: async (orgId) => (await entitlements(orgId)).externalMcp,
    rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
    onError: (error, code) =>
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mcp_error',
          code,
          name: error instanceof Error ? error.name : undefined,
        }),
      ),
  };
}
