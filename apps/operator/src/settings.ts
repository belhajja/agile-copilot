export type Mode = 'local' | 'server';

export interface Oidc {
  provider: 'keycloak' | 'oidc';
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface Registry {
  user: string;
  token: string;
}

export interface Settings {
  mode: Mode;
  port: number;
  domain: string | null;
  acmeEmail: string | null;
  jiraHosts: string[];
  privateHosts: string[];
  oidc: Oidc | null;
  registry: Registry | null;
}

export const SETTING_KEYS = [
  'mode',
  'port',
  'domain',
  'acme-email',
  'jira-hosts',
  'private-hosts',
  'oidc-provider',
  'oidc-issuer',
  'oidc-client-id',
  'oidc-client-secret',
  'registry-user',
  'registry-token',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Answers from flags or prompts, by flag name. */
export type RawSettings = Partial<Record<SettingKey, string>>;

export class SettingsError extends Error {
  override name = 'SettingsError';
  constructor(
    readonly field: SettingKey,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

export interface Prompter {
  ask(question: string, o?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Values go unquoted into .env, which Compose interpolates: none of these may appear.
const UNSAFE = /[\s$"'`#\\]/;

function clean(field: SettingKey, value: string | undefined): string {
  const v = (value ?? '').trim();
  if (UNSAFE.test(v)) {
    throw new SettingsError(field, 'must not contain spaces, quotes, $, # or backslashes');
  }
  return v;
}

export function parseHostList(field: SettingKey, raw: string | undefined): string[] {
  if (!(raw ?? '').trim()) return [];
  return (raw ?? '').split(',').map((part) => {
    const host = clean(field, part).toLowerCase();
    if (!HOSTNAME.test(host)) throw new SettingsError(field, `"${host}" is not a host name`);
    return host;
  });
}

function oidcOf(raw: RawSettings): Oidc | null {
  const issuer = clean('oidc-issuer', raw['oidc-issuer']);
  const clientId = clean('oidc-client-id', raw['oidc-client-id']);
  const clientSecret = clean('oidc-client-secret', raw['oidc-client-secret']);
  const given = [issuer, clientId, clientSecret].filter(Boolean).length;
  if (given === 0) return null;
  if (given < 3) {
    throw new SettingsError('oidc-issuer', 'set the issuer, client id and client secret together');
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new SettingsError('oidc-issuer', 'must be a URL');
  }
  if (url.protocol !== 'https:') throw new SettingsError('oidc-issuer', 'must use https');
  const provider = clean('oidc-provider', raw['oidc-provider'] || 'keycloak');
  if (provider !== 'keycloak' && provider !== 'oidc') {
    throw new SettingsError('oidc-provider', 'must be keycloak or oidc');
  }
  return { provider, issuer, clientId, clientSecret };
}

function registryOf(raw: RawSettings): Registry | null {
  const user = clean('registry-user', raw['registry-user']);
  const token = clean('registry-token', raw['registry-token']);
  if (!user && !token) return null;
  if (!user || !token) {
    throw new SettingsError('registry-user', 'set the deploy token user and token together');
  }
  return { user, token };
}

export function validateSettings(raw: RawSettings): Settings {
  const mode = clean('mode', raw.mode || 'local');
  if (mode !== 'local' && mode !== 'server') {
    throw new SettingsError('mode', 'must be local or server');
  }
  const portText = clean('port', raw.port || '3000');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new SettingsError('port', 'must be a number from 1 to 65535');
  }
  let domain: string | null = null;
  let acmeEmail: string | null = null;
  if (mode === 'server') {
    domain = clean('domain', raw.domain).toLowerCase();
    if (!HOSTNAME.test(domain) || !domain.includes('.')) {
      throw new SettingsError('domain', 'must be a DNS name such as copilot.example.com');
    }
    acmeEmail = clean('acme-email', raw['acme-email']);
    if (!EMAIL.test(acmeEmail)) {
      throw new SettingsError('acme-email', "must be an e-mail address (Let's Encrypt account)");
    }
  }
  return {
    mode,
    port,
    domain,
    acmeEmail,
    jiraHosts: parseHostList('jira-hosts', raw['jira-hosts']),
    privateHosts: parseHostList('private-hosts', raw['private-hosts']),
    oidc: oidcOf(raw),
    registry: registryOf(raw),
  };
}

export function publicUrl(s: Settings): string {
  return s.mode === 'server' ? `https://${s.domain}` : `http://localhost:${s.port}`;
}

const isServer = (raw: RawSettings) => raw.mode === 'server';

/** What `install` asks for, in order. SSO is set with flags only (`--oidc-*`). */
export const PROMPTS: {
  key: SettingKey;
  question: string;
  default?: string;
  secret?: boolean;
  when?: (raw: RawSettings) => boolean;
}[] = [
  {
    key: 'mode',
    question: 'Mode: local (this computer) or server (HTTPS with a domain)',
    default: 'local',
  },
  {
    key: 'port',
    question: 'Port to publish the app on',
    default: '3000',
    when: (r) => !isServer(r),
  },
  { key: 'domain', question: 'Domain (its DNS points at this server)', when: isServer },
  { key: 'acme-email', question: "E-mail for Let's Encrypt", when: isServer },
  {
    key: 'jira-hosts',
    question: 'Jira Data Center hosts the assistant may reach (comma-separated, empty for none)',
    default: '',
  },
  {
    key: 'private-hosts',
    question: 'Hosts on a private network the app may reach (comma-separated, empty for none)',
    default: '',
  },
  {
    key: 'registry-user',
    question: 'Registry deploy token user (empty if this host is already logged in)',
    default: '',
  },
  {
    key: 'registry-token',
    question: 'Registry deploy token',
    secret: true,
    when: (r) => Boolean(r['registry-user']),
  },
];

/** Fills in what the flags left out: from prompts, or from the defaults with `--yes`. */
export async function gatherSettings(
  raw: RawSettings,
  prompt: Prompter,
  yes: boolean,
): Promise<RawSettings> {
  const answers: RawSettings = { ...raw };
  for (const p of PROMPTS) {
    if (answers[p.key] !== undefined || (p.when && !p.when(answers))) continue;
    answers[p.key] = yes
      ? (p.default ?? '')
      : await prompt.ask(p.question, { default: p.default, secret: p.secret });
  }
  return answers;
}
