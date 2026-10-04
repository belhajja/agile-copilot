import { toNextJsHandler } from 'better-auth/next-js';
import { services } from '@/server/context';

/** Requests that need the identity provider itself: SSO start, link and callback. */
const SSO_PATH = /^\/api\/auth\/(sign-in\/social|link-social|callback\/|oauth2\/)/;

/**
 * Every auth request lets a late identity provider come online (AuthHolder.ssoReady retries
 * discovery at most every 30 s, each attempt bounded by a few seconds). Only SSO requests wait
 * for that attempt; password and session requests never wait for the identity provider.
 */
async function handler(req: Request) {
  const { authHolder } = services();
  const ready = authHolder.ssoReady();
  if (SSO_PATH.test(new URL(req.url).pathname)) await ready;
  return toNextJsHandler(authHolder.get());
}

export const GET = async (req: Request) => (await handler(req)).GET(req);
export const POST = async (req: Request) => (await handler(req)).POST(req);
