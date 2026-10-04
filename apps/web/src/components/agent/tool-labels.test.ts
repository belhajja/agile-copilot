import { describe, expect, it } from 'vitest';
import { toolLabel } from './tool-labels';

const t = (key: string) => `label:${key}`;

describe('tool labels (model-chosen names, M4)', () => {
  it('labels a known tool', () => {
    expect(toolLabel(t, 'jira_search')).toBe('label:tools.jira_search');
  });

  it.each(['constructor', '__proto__', 'toString', 'tools', 'jira_search.x', 'made_up_tool'])(
    'shows %s as is, without a lookup',
    (name) => {
      expect(toolLabel(t, name)).toBe(name);
    },
  );
});
