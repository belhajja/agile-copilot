import { describe, expect, it } from 'vitest';
import { jiraBrowseUrl } from './jira-link';

describe('jiraBrowseUrl', () => {
  it('links an issue key on the site', () => {
    expect(jiraBrowseUrl('https://acme.atlassian.net', 'DEMO-12')).toBe(
      'https://acme.atlassian.net/browse/DEMO-12',
    );
    expect(jiraBrowseUrl('https://acme.atlassian.net/', 'DEMO-12')).toBe(
      'https://acme.atlassian.net/browse/DEMO-12',
    );
  });

  it('keeps a Data Center context path, drops query and fragment', () => {
    expect(jiraBrowseUrl('http://jira.internal:8080/jira/?x=1#top', 'OPS_2-7')).toBe(
      'http://jira.internal:8080/jira/browse/OPS_2-7',
    );
  });

  it.each([
    ['javascript:alert(1)//', 'DEMO-1'],
    ['data:text/html,hi', 'DEMO-1'],
    ['ftp://jira.example', 'DEMO-1'],
    ['https://user:pw@jira.example', 'DEMO-1'],
    ['not a url', 'DEMO-1'],
    ['', 'DEMO-1'],
    [null, 'DEMO-1'],
    ['https://jira.example', 'DEMO-1/../../admin'],
    ['https://jira.example', 'Fix the login'],
    ['https://jira.example', '-1'],
  ])('refuses %s with %s', (base, key) => {
    expect(jiraBrowseUrl(base, key)).toBeNull();
  });
});
