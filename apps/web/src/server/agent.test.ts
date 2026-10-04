import { JiraToolError } from '@agile/jira-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./sync', () => ({
  syncDeps: () => ({ allowedPrivateHosts: ['jira.internal'] }),
}));
vi.mock('./context', () => ({
  services: () => ({ env: { MCP_ATLASSIAN_URL: 'http://mcp-atlassian:8000/mcp' } }),
}));

const { agentDeps } = await import('./agent');

describe('agentDeps', () => {
  afterEach(() => vi.restoreAllMocks());

  it('extends the sync deps (pinned fetch allowlist) with the mcp-atlassian URL', () => {
    const deps = agentDeps();
    expect(deps.allowedPrivateHosts).toEqual(['jira.internal']);
    expect(deps.mcpAtlassianUrl).toBe('http://mcp-atlassian:8000/mcp');
  });

  it('logs only the code and the error name, never message, cause or tool data', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'sk-live-FAKE-SECRET-123';
    const error = new JiraToolError('ambiguous_user', {
      candidates: [{ id: 'acc-777', displayName: 'Candidate Name' }],
    });
    error.message = `boom ${secret}`;
    error.cause = new Error(`cause ${secret}`);
    agentDeps().onError?.(error, 'tool_failed');

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      event: 'agent_error',
      code: 'tool_failed',
      name: 'JiraToolError',
    });
    for (const leaked of [secret, 'acc-777', 'Candidate Name', 'boom', 'cause']) {
      expect(line).not.toContain(leaked);
    }
  });

  it('logs a non-error value without a name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    agentDeps().onError?.('secret string', 'x');
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      level: 'error',
      event: 'agent_error',
      code: 'x',
    });
  });
});
