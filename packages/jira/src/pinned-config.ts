import { createPinnedAgents, type OutboundPolicy } from '@agile/net';

/**
 * axios settings (jira.js v5) that pin connections to the policy. `proxy: false` is required:
 * with HTTP(S)_PROXY set, axios would hand the request to a proxy that resolves the host itself,
 * bypassing the pinned agents.
 */
export function pinnedRequestConfig(outbound: OutboundPolicy | undefined) {
  return outbound ? { proxy: false as const, ...createPinnedAgents(outbound) } : {};
}
