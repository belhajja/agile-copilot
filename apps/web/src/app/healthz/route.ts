export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness of the web process, for the compose health check and the Helm probes.
 * Public (exact path in proxy.ts) and dependency-free: no database, no identity provider (an IdP
 * outage must not take every web pod out of the Service; password sign-in keeps working).
 */
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
