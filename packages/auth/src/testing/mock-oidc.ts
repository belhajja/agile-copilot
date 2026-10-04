import { OAuth2Server } from 'oauth2-mock-server';

/** The person the mock identity provider signs in next. */
export interface OidcUser {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface MockOidc {
  /** Issuer URL (discovery at `${issuer}/.well-known/openid-configuration`). */
  issuer: string;
  /** Every later login (until the next call) signs in as this person. */
  setUser(user: OidcUser): void;
  close(): Promise<void>;
}

/**
 * A real OIDC provider for tests (oauth2-mock-server): discovery, JWKS, authorization code with
 * PKCE and nonce, signed ID tokens, userinfo. Its authorize endpoint redirects straight back with
 * a code (no login page); the identity is whatever `setUser` chose.
 */
export async function startMockOidc(
  opts: { port?: number; host?: string } = {},
): Promise<MockOidc> {
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');
  await server.start(opts.port ?? 0, opts.host ?? '127.0.0.1');
  let user: OidcUser = {
    sub: 'sso-user-1',
    email: 'sso.user@example.com',
    name: 'Sso User',
    emailVerified: true,
  };
  const claims = () => ({
    sub: user.sub,
    email: user.email,
    email_verified: user.emailVerified,
    name: user.name,
  });
  server.service.on('beforeTokenSigning', (token) => {
    Object.assign(token.payload, claims());
  });
  server.service.on('beforeUserinfo', (response) => {
    response.body = claims();
  });
  const issuer = server.issuer.url;
  if (!issuer) throw new Error('mock OIDC issuer has no URL');
  return {
    issuer,
    setUser: (u) => {
      user = u;
    },
    close: () => server.stop(),
  };
}

const cookiesOf = (res: Response, jar: Map<string, string>) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
};
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** A better-auth instance as far as the SSO round trip needs it. */
interface AuthHandler {
  handler(request: Request): Promise<Response>;
}

/**
 * Runs the browser's part of an SSO sign-in against `auth.handler`: start → IdP authorize →
 * callback. Returns the final redirect and the cookies (session included when it worked).
 * `link` signs in to link the identity to the session in `cookies` instead.
 */
export async function ssoRoundTrip(
  auth: AuthHandler,
  opts: { baseURL: string; provider: string; cookies?: Map<string, string>; link?: boolean },
): Promise<{ location: string; cookies: Map<string, string> }> {
  const jar = new Map(opts.cookies ?? []);
  const path = opts.link ? '/api/auth/link-social' : '/api/auth/sign-in/social';
  const start = await auth.handler(
    new Request(new URL(path, opts.baseURL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jar) },
      body: JSON.stringify({ provider: opts.provider, callbackURL: '/' }),
    }),
  );
  cookiesOf(start, jar);
  const { url } = (await start.json()) as { url?: string };
  if (!url) throw new Error(`SSO start failed (${start.status})`);
  const authorize = await fetch(url, { redirect: 'manual' });
  const callback = authorize.headers.get('location');
  if (!callback) throw new Error(`IdP did not redirect (${authorize.status})`);
  const done = await auth.handler(
    new Request(callback, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' }),
  );
  cookiesOf(done, jar);
  return { location: done.headers.get('location') ?? '', cookies: jar };
}
