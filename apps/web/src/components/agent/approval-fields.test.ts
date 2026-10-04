import { JIRA_TOOLS, JIRA_WRITE_TOOLS } from '@agile/jira-tools/catalog';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import fr from '../../../messages/fr.json';
import { APPROVAL_FIELDS } from './approval-fields';

describe('approval card fields', () => {
  it('shows every field a Jira write can send, and the site it goes to', () => {
    const sent = new Set(['site']);
    for (const name of JIRA_WRITE_TOOLS) {
      for (const key of Object.keys(JIRA_TOOLS[name].input.shape)) sent.add(key);
    }
    expect([...sent].filter((k) => !(APPROVAL_FIELDS as readonly string[]).includes(k))).toEqual(
      [],
    );
  });

  it('labels each field in both languages', () => {
    for (const messages of [en, fr]) {
      const labels = messages.agent.fields as Record<string, string>;
      expect(APPROVAL_FIELDS.filter((f) => !labels[f])).toEqual([]);
    }
  });
});
