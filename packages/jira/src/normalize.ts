import type { JiraCredentials, JiraDeployment } from './types';

const CLOUD_HOST = /\.(atlassian\.net|jira\.com)$/i;
// Path segments that start an in-app page rather than the base URL (DC keeps any context path before them).
const APP_PATH =
  /\/(browse|secure|projects|issues|plugins|jira\/software|rest|login\.jsp)(\/.*)?$/i;

export function inferDeployment(url: string): JiraDeployment {
  try {
    return CLOUD_HOST.test(new URL(url.trim()).hostname) ? 'cloud' : 'datacenter';
  } catch {
    return 'datacenter';
  }
}

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim()); // throws TypeError on invalid input
  if (CLOUD_HOST.test(url.hostname)) return url.origin;
  const path = url.pathname.replace(APP_PATH, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function normalizeCredentials(c: JiraCredentials): JiraCredentials {
  const baseUrl = normalizeBaseUrl(c.baseUrl);
  switch (c.kind) {
    case 'cloud_basic':
      return { kind: c.kind, baseUrl, email: c.email.trim(), apiToken: c.apiToken.trim() };
    case 'cloud_oauth':
      return {
        kind: c.kind,
        baseUrl,
        cloudId: c.cloudId.trim(),
        accessToken: c.accessToken.trim(),
      };
    case 'datacenter_pat':
      return { kind: c.kind, baseUrl, token: c.token.trim() };
  }
}
