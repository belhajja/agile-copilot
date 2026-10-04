import { describe, expect, it } from 'vitest';
import { desktopConfig, MCP_REMOTE_VERSION, mcpEndpoint } from './client-config';

const TOKEN = 'acp_org_1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('mcpEndpoint', () => {
  it('builds the endpoint from the public app URL', () => {
    expect(mcpEndpoint('https://copilot.example.com')).toBe('https://copilot.example.com/api/mcp');
    expect(mcpEndpoint('https://example.com/base/')).toBe('https://example.com/api/mcp');
  });

  it('accepts plain http only on this machine (development)', () => {
    expect(mcpEndpoint('http://localhost:3200')).toBe('http://localhost:3200/api/mcp');
    expect(mcpEndpoint('http://127.0.0.1:3200')).toBe('http://127.0.0.1:3200/api/mcp');
    // A token must never be sent in clear over a network.
    expect(mcpEndpoint('http://copilot.corp.example')).toBeNull();
    expect(mcpEndpoint('not a url')).toBeNull();
  });
});

describe('desktopConfig', () => {
  const config = JSON.parse(desktopConfig('https://copilot.example.com/api/mcp', TOKEN));
  const server = config.mcpServers['agile-copilot'];

  it('pins the exact mcp-remote version (npx never fetches whatever is latest)', () => {
    expect(MCP_REMOTE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(server.command).toBe('npx');
    expect(server.args).toContain(`mcp-remote@${MCP_REMOTE_VERSION}`);
    expect(server.args.some((a: string) => a === 'mcp-remote' || a.includes('@latest'))).toBe(
      false,
    );
  });

  it('keeps the token in the environment, out of the process arguments', () => {
    expect(server.args).toEqual([
      '-y',
      `mcp-remote@${MCP_REMOTE_VERSION}`,
      'https://copilot.example.com/api/mcp',
      '--header',
      // No spaces: some clients split arguments on them; mcp-remote expands ${AUTH_HEADER}.
      `Authorization:${'$'}{AUTH_HEADER}`,
    ]);
    expect(JSON.stringify(server.args)).not.toContain(TOKEN);
    expect(server.env).toEqual({ AUTH_HEADER: `Bearer ${TOKEN}` });
    // Never weakens the transport.
    expect(server.args).not.toContain('--allow-http');
  });
});
