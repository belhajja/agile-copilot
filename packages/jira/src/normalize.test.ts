import { describe, expect, it } from 'vitest';
import { inferDeployment, normalizeBaseUrl, normalizeCredentials } from './normalize';

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://acme.atlassian.net/', 'https://acme.atlassian.net'],
    [
      '  https://acme.atlassian.net/jira/software/projects/X/boards/1?selectedIssue=X-1 ',
      'https://acme.atlassian.net',
    ],
    ['https://ACME.atlassian.net/browse/X-1#comment', 'https://acme.atlassian.net'],
    ['https://jira.corp.example/jira/', 'https://jira.corp.example/jira'],
    ['https://jira.corp.example/jira/browse/ABC-12', 'https://jira.corp.example/jira'],
    ['https://jira.corp.example/secure/Dashboard.jspa', 'https://jira.corp.example'],
    ['http://jira.corp.local:8080/projects/ABC/issues', 'http://jira.corp.local:8080'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });

  it('throws on garbage', () => {
    expect(() => normalizeBaseUrl('jira')).toThrow(TypeError);
  });
});

describe('inferDeployment', () => {
  it('detects Atlassian Cloud hosts', () => {
    expect(inferDeployment('https://acme.atlassian.net')).toBe('cloud');
    expect(inferDeployment('https://jira.corp.example')).toBe('datacenter');
  });
});

describe('normalizeCredentials', () => {
  it('trims pasted whitespace and normalises the URL', () => {
    expect(
      normalizeCredentials({
        kind: 'cloud_basic',
        baseUrl: 'https://acme.atlassian.net/ ',
        email: ' pm@acme.com\n',
        apiToken: '\tATATT3xFfGF0abc\n',
      }),
    ).toEqual({
      kind: 'cloud_basic',
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'ATATT3xFfGF0abc',
    });
    expect(
      normalizeCredentials({
        kind: 'datacenter_pat',
        baseUrl: 'https://j.example/jira/',
        token: ' t \n',
      }),
    ).toEqual({ kind: 'datacenter_pat', baseUrl: 'https://j.example/jira', token: 't' });
  });
});
