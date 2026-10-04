import { describe, expect, it } from 'vitest';
import { exactPerson, JiraToolError } from './backend';
import { ISSUE_KEY_PATTERN, JIRA_TOOLS } from './catalog';

const person = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  person: { id, displayName },
  keys: [id, displayName, extra.email],
  active: extra.active,
  accountType: extra.accountType,
});

describe('exactPerson (both backends resolve assignees with it)', () => {
  it('returns the one person whose id, name or email equals the text, ignoring case', () => {
    const people = [person('alex', 'Alex Martin'), person('ann', 'Ann Lee', { email: 'a@x.io' })];
    expect(exactPerson(people, 'alex martin', { cloud: false })).toEqual({
      id: 'alex',
      displayName: 'Alex Martin',
    });
    expect(exactPerson(people, 'A@X.IO', { cloud: false })).toEqual({
      id: 'ann',
      displayName: 'Ann Lee',
    });
  });

  it('skips inactive people, and app or customer accounts on Cloud, when Jira says so', () => {
    const people = [
      person('old', 'Alex Martin', { active: false }),
      person('bot', 'Alex Martin', { accountType: 'app' }),
      person('alex', 'Alex Martin', { accountType: 'atlassian' }),
    ];
    expect(exactPerson(people, 'Alex Martin', { cloud: true }).id).toBe('alex');
    // Data Center has no account types: only the inactive one is skipped.
    expect(() => exactPerson(people, 'Alex Martin', { cloud: false })).toThrow(
      expect.objectContaining({ code: 'ambiguous_user' }),
    );
  });

  it('never picks a partial match: candidates (at most 5) or not found', () => {
    const many = [1, 2, 3, 4, 5, 6].map((i) => person(`ann${i}`, `Ann ${i}`));
    const err = (() => {
      try {
        exactPerson(many, 'Ann', { cloud: false });
      } catch (e) {
        return e;
      }
    })() as JiraToolError;
    expect(err).toBeInstanceOf(JiraToolError);
    expect(err.code).toBe('ambiguous_user');
    expect(err.candidates).toHaveLength(5);
    expect(() => exactPerson([], 'Ann', { cloud: false })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('ISSUE_KEY_PATTERN', () => {
  it('is the pattern the catalog validates issue keys with', () => {
    for (const key of ['DEMO-1', 'A_B9-123456789', 'demo-1', 'DEMO-', '1DEMO-1', 'DEMO-1 ']) {
      expect(ISSUE_KEY_PATTERN.test(key)).toBe(
        JIRA_TOOLS.jira_get_transitions.input.safeParse({ issueKey: key.trimEnd() }).success &&
          key === key.trim(),
      );
    }
  });
});
