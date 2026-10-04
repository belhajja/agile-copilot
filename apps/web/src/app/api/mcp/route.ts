import { handleMcpHttpRequest } from '@agile/mcp-gateway';
import { mcpDeps } from '@/server/mcp';
import { preAuthLimit } from '@/server/mcp-ip-limit';

// The MCP SDK transport and the token hashing use Node APIs.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The analytics MCP server for external clients (streamable HTTP, stateless, JSON responses).
 * Public in proxy.ts (exact path): authenticated by a personal token (`Authorization: Bearer
 * acp_…`), never by the session cookie, so there is no session and no CSRF surface; no CORS
 * headers (browsers on other origins cannot read the answers). POST only: Next answers 405 to
 * every other method. A cheap per-address limit runs first, before any database work.
 */
export async function POST(request: Request) {
  return preAuthLimit(request) ?? handleMcpHttpRequest(mcpDeps(), request);
}
