/**
 * The exact mcp-remote release the generated configuration runs (L19): `npx` then never fetches
 * whatever was published last under that name. Update it deliberately, after reading its changes.
 */
export const MCP_REMOTE_VERSION = '0.14.3';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The MCP endpoint under the public app URL (`BETTER_AUTH_URL`): https, or plain http on this
 * machine only (development). Null otherwise: a token must never cross a network in clear, so no
 * configuration is offered (and `--allow-http` never is).
 */
export function mcpEndpoint(appUrl: string): string | null {
  let url: URL;
  try {
    url = new URL('/api/mcp', appUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.toString();
  return null;
}

/** mcp-remote expands ${AUTH_HEADER} from `env` (keeps the token out of the process list). */
const HEADER_ARG = `Authorization:${'$'}{AUTH_HEADER}`;

/** Claude Desktop reaches a remote MCP server with a header through the mcp-remote bridge. */
export const desktopConfig = (endpoint: string, token: string) =>
  JSON.stringify(
    {
      mcpServers: {
        'agile-copilot': {
          command: 'npx',
          args: ['-y', `mcp-remote@${MCP_REMOTE_VERSION}`, endpoint, '--header', HEADER_ARG],
          env: { AUTH_HEADER: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
