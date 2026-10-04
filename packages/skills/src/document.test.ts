import { describe, expect, it } from 'vitest';
import { parseSkillDocument, serializeSkill } from './document';
import { BUILTIN_SKILLS } from './library';
import { alertMatches, alertWidget } from './schema';

const doc = (front: string, body = 'Do the thing.') => `---\n${front}\n---\n\n${body}\n`;

describe('SKILL.md documents', () => {
  it('parses frontmatter and instructions, filling defaults', () => {
    const r = parseSkillDocument(doc('name: sprint-digest\ndescription: Weekly sprint digest'));
    expect(r).toEqual({
      ok: true,
      skill: {
        frontmatter: {
          name: 'sprint-digest',
          description: 'Weekly sprint digest',
          trigger: 'on_demand',
          output: 'chat',
        },
        instructions: 'Do the thing.',
      },
    });
  });

  it('accepts a schedule with a time zone and an email output', () => {
    const r = parseSkillDocument(
      doc(
        'name: monday-risks\ndescription: Stories at risk\ntrigger: schedule\nschedule:\n  cron: "0 8 * * 1"\n  timezone: Europe/Paris\noutput: email',
      ),
    );
    expect(r.ok && r.skill.frontmatter.schedule).toEqual({
      cron: '0 8 * * 1',
      timezone: 'Europe/Paris',
    });
  });

  it('round-trips through serializeSkill', () => {
    const text = serializeSkill({
      frontmatter: {
        name: 'wip-alert',
        description: 'Too much work in progress',
        trigger: 'alert',
        alert: { metric: 'wip', op: '>', value: 10 },
        output: 'slack',
        scope: { boards: ['5f0c6a3e-8a1b-4c2d-9e3f-0a1b2c3d4e5f'] },
      },
      instructions: '  Explain why WIP is high.  ',
    });
    expect(text.startsWith('---\nname: wip-alert\n')).toBe(true);
    const r = parseSkillDocument(text);
    expect(r.ok && r.skill.frontmatter).toMatchObject({
      trigger: 'alert',
      alert: { metric: 'wip', op: '>', value: 10 },
      output: 'slack',
    });
    expect(r.ok && r.skill.instructions).toBe('Explain why WIP is high.');
  });

  it.each([
    ['no frontmatter', 'Just text', [{ code: 'missing_frontmatter' }]],
    ['broken YAML', doc('name: [unclosed'), [{ code: 'invalid_yaml' }]],
    ['a YAML list', doc('- a\n- b'), [{ code: 'invalid_yaml' }]],
    ['duplicate keys', doc('name: a\nname: b\ndescription: x'), [{ code: 'invalid_yaml' }]],
    [
      'an unknown key',
      doc('name: a\ndescription: x\nrecipients: [boss@example.com]'),
      [{ code: 'unknown_field', field: 'recipients' }],
    ],
    [
      'a bad name',
      doc('name: Sprint Digest\ndescription: x'),
      [{ code: 'invalid', field: 'name' }],
    ],
    ['no description', doc('name: a'), [{ code: 'required', field: 'description' }]],
    ['empty instructions', doc('name: a\ndescription: x', '   '), [{ code: 'empty_instructions' }]],
    [
      'a schedule without cron',
      doc('name: a\ndescription: x\ntrigger: schedule'),
      [{ code: 'required', field: 'schedule' }],
    ],
    [
      'every 5 minutes',
      doc('name: a\ndescription: x\ntrigger: schedule\nschedule:\n  cron: "*/5 * * * *"'),
      [{ code: 'cron_too_frequent', field: 'schedule' }],
    ],
    [
      'an unknown time zone',
      doc(
        'name: a\ndescription: x\ntrigger: schedule\nschedule:\n  cron: "0 8 * * 1"\n  timezone: Mars/Base',
      ),
      [{ code: 'timezone_invalid', field: 'schedule' }],
    ],
    [
      'a 6-field cron',
      doc('name: a\ndescription: x\ntrigger: schedule\nschedule:\n  cron: "0 0 8 * * 1"'),
      [{ code: 'cron_invalid', field: 'schedule' }],
    ],
    [
      'an on-demand skill that emails',
      doc('name: a\ndescription: x\noutput: email'),
      [{ code: 'chat_only', field: 'output' }],
    ],
    [
      'an alert on a chart metric',
      doc('name: a\ndescription: x\ntrigger: alert\nalert:\n  metric: cfd\n  op: ">"\n  value: 1'),
      [{ code: 'invalid', field: 'alert.metric' }],
    ],
    [
      'alert params out of range',
      doc(
        'name: a\ndescription: x\ntrigger: alert\nalert:\n  metric: cycle_time\n  params: { windowDays: 9999 }\n  op: ">"\n  value: 5',
      ),
      [{ code: 'invalid', field: 'alert.params' }],
    ],
    [
      'a description with a bidi override',
      doc('name: a\ndescription: "safe‮evil"'),
      [{ code: 'invalid', field: 'description' }],
    ],
  ])('refuses %s with a code', (_label, text, issues) => {
    expect(parseSkillDocument(text)).toEqual({ ok: false, issues });
  });

  it('refuses YAML alias bombs and oversized documents', () => {
    const bomb = doc(
      `name: a\ndescription: x\nx0: &a [1,1,1,1,1,1,1,1,1,1]\n${Array.from({ length: 12 }, (_, i) => `x${i + 1}: &a${i + 1} [*a, *a, *a]`).join('\n')}`,
    );
    expect(parseSkillDocument(bomb).ok).toBe(false);
    expect(parseSkillDocument(doc('name: a\ndescription: x', 'x'.repeat(24_001)))).toEqual({
      ok: false,
      issues: [{ code: 'too_long' }],
    });
  });

  it('ships the nine built-in skills, valid and on demand', () => {
    expect(BUILTIN_SKILLS.map((s) => s.key)).toEqual([
      'sprint-health-check',
      'daily-standup-brief',
      'retro-prep',
      'stale-work-detector',
      'scope-creep-watcher',
      'delivery-forecast',
      'blocker-report',
      'kanban-flow-review',
      'team-workload-balance',
    ]);
    for (const s of BUILTIN_SKILLS) {
      expect(parseSkillDocument(s.document)).toEqual({ ok: true, skill: s.skill });
      expect(s.skill.frontmatter.trigger).toBe('on_demand');
    }
  });
});

describe('alert conditions', () => {
  it('reads the KPI widget with catalog defaults', () => {
    expect(alertWidget({ metric: 'cycle_time' })).toEqual({
      id: 'alert',
      metric: 'cycle_time',
      chart: 'kpi',
      params: { windowDays: 90, percentile: 85 },
    });
    expect(alertWidget({ metric: 'velocity' })).toBeNull();
  });

  it('compares deterministically; no data never matches', () => {
    expect(alertMatches('>', 11, 10)).toBe(true);
    expect(alertMatches('>', 10, 10)).toBe(false);
    expect(alertMatches('>=', 10, 10)).toBe(true);
    expect(alertMatches('<', 0.5, 0.8)).toBe(true);
    expect(alertMatches('<=', 0.9, 0.8)).toBe(false);
    expect(alertMatches('<', null, 10)).toBe(false);
    expect(alertMatches('>', Number.NaN, 10)).toBe(false);
  });
});
