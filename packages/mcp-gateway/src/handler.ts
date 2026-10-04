import { createAnalyticsMcpServer } from '@agile/analytics-mcp';
import { recordAudit, withOrg } from '@agile/db';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { BodyTooLargeError, readBodyCapped } from './body';
import { DEFAULT_RATE_LIMIT_PER_MINUTE, takeRequest } from './rate-limit';
import { authenticateToken, type GatewayDeps, type TokenIdentity } from './tokens';

export interface McpHttpDeps extends GatewayDeps {
  /** Requests per token per minute (`MCP_RATE_LIMIT_PER_MINUTE`). */
  rateLimitPerMinute?: number;
  /** Log hook: error name and code only. */
  onError?: (error: unknown, code: string) => void;
}

/** A JSON-RPC request body is small (tool name and a few arguments). */
export const MAX_MCP_BODY_BYTES = 64 * 1024;

/** The fixed codes this endpoint answers with (the body is `{ "error": code }`). */
export type McpHttpErrorCode =
  | 'method_not_allowed'
  | 'unauthorized'
  | 'rate_limited'
  | 'payload_too_large'
  | 'invalid_json'
  | 'internal_error';

const jsonError = (status: number, error: McpHttpErrorCode, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers });

const unauthorized = () =>
  jsonError(401, 'unauthorized', { 'www-authenticate': 'Bearer realm="agile-copilot-mcp"' });

/** Tool names as the analytics server spells them; anything else is audited as `unknown`. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The tools a JSON-RPC body calls (single message or batch). Never their arguments. */
function calledTools(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    if (msg?.method !== 'tools/call') return [];
    const name = msg.params?.name;
    return [typeof name === 'string' && TOOL_NAME.test(name) ? name : 'unknown'];
  });
}

async function serve(deps: McpHttpDeps, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', { allow: 'POST' });
  }
  // Bearer tokens only: the session cookie is never read here.
  const header = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) return unauthorized();
  const identity: TokenIdentity | null = await authenticateToken(deps, token);
  if (!identity) return unauthorized();

  const limit = await takeRequest(
    deps.db,
    identity,
    deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
    deps.now?.(),
  );
  if (!limit.allowed) {
    return jsonError(429, 'rate_limited', { 'retry-after': String(limit.retryAfterSeconds) });
  }

  let text: string;
  try {
    text = await readBodyCapped(request, MAX_MCP_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return jsonError(413, 'payload_too_large');
    throw e;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonError(400, 'invalid_json');
  }

  const tools = calledTools(body);
  if (tools.length > 0) {
    await withOrg(deps.db, identity.orgId, async (tx) => {
      for (const tool of tools) {
        await recordAudit(tx, {
          orgId: identity.orgId,
          actorUserId: identity.userId,
          action: 'mcp.tool_called',
          targetType: 'mcp_token',
          targetId: identity.tokenId,
          metadata: { tool },
        });
      }
    });
  }

  const server = createAnalyticsMcpServer(
    { db: deps.db, orgId: identity.orgId, now: deps.now ?? (() => new Date()) },
    { onError: (e, code) => deps.onError?.(e, code) },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}

/**
 * The analytics MCP server over streamable HTTP for external clients (Claude Desktop through a
 * remote-MCP bridge, other MCP clients). Stateless: each POST is authenticated with a personal
 * token, rate limited, audited (one entry per tool call: its name, never its input or output), and
 * served by a fresh server bound to the token's workspace. Read-only by construction: the analytics
 * server has no write tool, and no Jira tool is ever exposed here. Failures are fixed codes.
 */
export async function handleMcpHttpRequest(deps: McpHttpDeps, request: Request): Promise<Response> {
  try {
    return await serve(deps, request);
  } catch (e) {
    try {
      deps.onError?.(e, 'internal_error');
    } catch {
      // A failing logger must not change the answer.
    }
    return jsonError(500, 'internal_error');
  }
}
