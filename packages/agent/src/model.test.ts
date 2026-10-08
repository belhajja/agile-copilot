import { describe, expect, it } from 'vitest';
import type { AgentDeps } from './deps';
import { usesInsecureTransport } from './model';

const deps = {
  allowedPrivateHosts: ['llm.corp.test'],
  resolve: async (host: string) => (host === 'llm.private.test' ? ['10.0.0.5'] : ['93.184.216.34']),
} as unknown as AgentDeps;
const compatible = (baseUrl: string) =>
  ({ provider: 'openai_compatible', model: 'm', baseUrl, apiKey: 'k' }) as const;

describe('usesInsecureTransport', () => {
  it('flags a stored plain-http endpoint on a public host', async () => {
    expect(await usesInsecureTransport(deps, compatible('http://llm.example.com/v1'))).toBe(true);
  });

  it('accepts https, allowlisted internal hosts and fixed vendor providers', async () => {
    expect(await usesInsecureTransport(deps, compatible('https://llm.example.com/v1'))).toBe(false);
    expect(await usesInsecureTransport(deps, compatible('http://llm.corp.test:11434/v1'))).toBe(
      false,
    );
    expect(
      await usesInsecureTransport(deps, {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'k',
      } as const),
    ).toBe(false);
  });

  it('leaves a private, non-allowlisted host to the pinned fetch (reported as blocked)', async () => {
    expect(await usesInsecureTransport(deps, compatible('http://llm.private.test/v1'))).toBe(false);
  });
});
