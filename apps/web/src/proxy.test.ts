import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3200${path}`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });

describe('proxy', () => {
  it('answers 401 JSON to an API call without a session cookie', async () => {
    const res = proxy(req('/api/agent/chat'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('redirects a page without a session cookie to /login', () => {
    const res = proxy(req('/boards/1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3200/login');
  });

  it('keeps the redirect for the Jira OAuth browser navigations', () => {
    const res = proxy(req('/api/jira/oauth/start'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3200/login');
  });

  it('lets public auth paths through', () => {
    const res = proxy(req('/api/auth/sign-in/email'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('lets a request with a session cookie through', () => {
    const res = proxy(req('/api/agent/chat', 'better-auth.session_token=abc'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
