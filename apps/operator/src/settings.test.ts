import { describe, expect, it } from 'vitest';
import {
  gatherSettings,
  type Prompter,
  parseHostList,
  publicUrl,
  SettingsError,
  validateSettings,
} from './settings';

const refused = (raw: Parameters<typeof validateSettings>[0], field: string) => {
  try {
    validateSettings(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(SettingsError);
    expect((e as SettingsError).field).toBe(field);
    return;
  }
  throw new Error(`expected ${field} to be refused`);
};

describe('settings', () => {
  it('defaults to a local install on port 3000', () => {
    const s = validateSettings({});
    expect(s).toMatchObject({ mode: 'local', port: 3000, domain: null, jiraHosts: [] });
    expect(publicUrl(s)).toBe('http://localhost:3000');
  });

  it('needs a domain and an e-mail on a server', () => {
    refused({ mode: 'server' }, 'domain');
    refused({ mode: 'server', domain: 'copilot.example.com' }, 'acme-email');
    const s = validateSettings({
      mode: 'server',
      domain: 'Copilot.Example.com',
      'acme-email': 'ops@example.com',
    });
    expect(publicUrl(s)).toBe('https://copilot.example.com');
  });

  it('refuses ports out of range and unknown modes', () => {
    refused({ port: '0' }, 'port');
    refused({ port: '70000' }, 'port');
    refused({ port: '30a' }, 'port');
    refused({ mode: 'cloud' }, 'mode');
  });

  it('parses host lists, lowercased, and refuses anything that is not a host', () => {
    expect(parseHostList('jira-hosts', ' Jira.Corp.local, portail.agir.orange.com ')).toEqual([
      'jira.corp.local',
      'portail.agir.orange.com',
    ]);
    expect(parseHostList('jira-hosts', '')).toEqual([]);
    expect(() => parseHostList('jira-hosts', 'https://jira.corp.local')).toThrow(SettingsError);
  });

  it('refuses values Compose would interpolate', () => {
    refused({ 'jira-hosts': 'jira.corp.local$x' }, 'jira-hosts');
    refused(
      {
        'oidc-issuer': 'https://sso.example.com/realms/agile',
        'oidc-client-id': 'agile',
        'oidc-client-secret': 'abc$def',
      },
      'oidc-client-secret',
    );
    refused({ 'registry-user': 'deploy token', 'registry-token': 'x' }, 'registry-user');
  });

  it('takes SSO and registry credentials all together or not at all', () => {
    refused({ 'oidc-issuer': 'https://sso.example.com/realms/agile' }, 'oidc-issuer');
    refused(
      {
        'oidc-issuer': 'http://sso.example.com',
        'oidc-client-id': 'a',
        'oidc-client-secret': 'b',
      },
      'oidc-issuer',
    );
    refused({ 'registry-user': 'gitlab+deploy-token-1' }, 'registry-user');
    expect(
      validateSettings({ 'registry-user': 'gitlab+deploy-token-1', 'registry-token': 'tok' })
        .registry,
    ).toEqual({ user: 'gitlab+deploy-token-1', token: 'tok' });
  });

  it('asks only for what the flags left out, and only what the mode needs', async () => {
    const asked: string[] = [];
    const prompt: Prompter = {
      ask: async (question, o) => {
        asked.push(question);
        return o?.default ?? '';
      },
      confirm: async () => true,
    };
    const raw = await gatherSettings({ mode: 'local', port: '3100' }, prompt, false);
    expect(raw).toMatchObject({ mode: 'local', port: '3100', 'jira-hosts': '' });
    expect(asked.some((q) => /Domain/.test(q))).toBe(false);
    expect(asked.some((q) => /Port/.test(q))).toBe(false);
  });

  it('asks for the OIDC client secret, hidden, when the issuer is given without one', async () => {
    const asked: { question: string; secret?: boolean }[] = [];
    const prompt: Prompter = {
      ask: async (question, o) => {
        asked.push({ question, secret: o?.secret });
        return /client secret/i.test(question) ? 's3cret' : (o?.default ?? '');
      },
      confirm: async () => true,
    };
    const raw = await gatherSettings(
      { 'oidc-issuer': 'https://sso.example.com/realms/x', 'oidc-client-id': 'copilot' },
      prompt,
      false,
    );
    expect(raw['oidc-client-secret']).toBe('s3cret');
    expect(asked.find((a) => /client secret/i.test(a.question))?.secret).toBe(true);
    // not asked when the secret came with the flags, nor without an issuer
    asked.length = 0;
    await gatherSettings(
      { 'oidc-issuer': 'https://sso.example.com', 'oidc-client-secret': 'x' },
      prompt,
      false,
    );
    await gatherSettings({}, prompt, false);
    expect(asked.some((a) => /client secret/i.test(a.question))).toBe(false);
  });

  it('asks nothing with --yes', async () => {
    const prompt: Prompter = {
      ask: async () => {
        throw new Error('asked');
      },
      confirm: async () => true,
    };
    expect(await gatherSettings({}, prompt, true)).toMatchObject({ mode: 'local', port: '3000' });
  });
});
