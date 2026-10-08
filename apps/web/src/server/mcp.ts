import 'server-only';
import type { McpHttpDeps } from '@agile/mcp-gateway';
import { errorName, log } from '@agile/observability/log';
import { entitlements } from './billing';
import { services } from './context';

/** External MCP: tokens checked against the workspace's plan (always allowed in self-host). */
export function mcpDeps(): McpHttpDeps {
  const { db, env } = services();
  return {
    db,
    planAllowsMcp: async (orgId) => (await entitlements(orgId)).externalMcp,
    rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
    onError: (error, code) => log('error', 'mcp_error', { code, error: errorName(error) }),
  };
}
