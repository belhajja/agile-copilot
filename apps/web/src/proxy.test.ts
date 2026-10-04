import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const req = (path: string, cookie?: string, method = 'POST') =>
  new NextRequest(`http://localhost:3200${path}`, {
    method,
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

  it('remembers the page a signed-out visitor opened (an invitation link)', () => {
    const res = proxy(req('/invitations/inv_123', undefined, 'GET'));
    expect(res.headers.get('location')).toBe(
      'http://localhost:3200/login?next=%2Finvitations%2Finv_123',
    );
  });

  it('keeps the query string of the page, and nothing for the home page', () => {
    expect(proxy(req('/boards/1?tab=flow', undefined, 'GET')).headers.get('location')).toBe(
      'http://localhost:3200/login?next=%2Fboards%2F1%3Ftab%3Dflow',
    );
    expect(proxy(req('/', undefined, 'GET')).headers.get('location')).toBe(
      'http://localhost:3200/login',
    );
  });

  it('never remembers an API navigation or an unsafe path', () => {
    for (const path of ['/api/jira/oauth/start', '/a//evil.example']) {
      expect(proxy(req(path, undefined, 'GET')).headers.get('location')).toBe(
        'http://localhost:3200/login',
      );
    }
  });

  it('keeps the redirect for the Jira OAuth browser navigations', () => {
    const res = proxy(req('/api/jira/oauth/start'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3200/login');
  });

  it('lets public auth paths, the Stripe webhook and token-authenticated MCP through', () => {
    for (const path of [
      '/api/auth/sign-in/email',
      '/api/auth/callback/keycloak',
      '/api/billing/webhook',
      '/api/mcp',
    ]) {
      const res = proxy(req(path));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('lets the health check through, at its exact path only', () => {
    const ok = proxy(req('/healthz', undefined, 'GET'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-middleware-next')).toBe('1');
    for (const path of ['/healthz/x', '/healthzz', '/HEALTHZ']) {
      expect(proxy(req(path, undefined, 'GET')).status).toBe(307);
    }
  });

  it('makes only the exact webhook path public (no sub-paths, no other case)', async () => {
    for (const path of [
      '/api/billing',
      '/api/billing/webhook-other',
      '/api/billing/portal',
      '/api/billing/webhook/x',
      '/API/billing/webhook',
    ]) {
      const res = proxy(req(path));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('makes only the exact MCP path public (no sub-paths, no other case)', async () => {
    for (const path of [
      '/api/mcp/x',
      '/api/mcp/',
      '/api/mcp-other',
      '/api/mcpx',
      '/API/mcp',
      '/api/MCP',
      '/Api/Mcp',
    ]) {
      const res = proxy(req(path));
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('lets a request with a session cookie through', () => {
    const res = proxy(req('/api/agent/chat', 'better-auth.session_token=abc'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
