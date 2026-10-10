import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOLLOWUPS_TOOL, followupsSchema, followupTools } from './followups';
import { skillRunPrompt, systemPrompt } from './prompt';

const parse = (suggestions: unknown) => followupsSchema.safeParse({ suggestions });

describe('suggest_followups', () => {
  it('takes 2 to 4 suggestions of at most 120 characters', () => {
    expect(parse(['Show the detail for Alice', 'Compare with the last sprint']).success).toBe(true);
    expect(parse(['a', 'b', 'c', 'd']).success).toBe(true);
    expect(parse(['only one']).success).toBe(false);
    expect(parse(['a', 'b', 'c', 'd', 'e']).success).toBe(false);
    expect(parse(['x'.repeat(120), 'ok']).success).toBe(true);
    expect(parse(['x'.repeat(121), 'ok']).success).toBe(false);
    expect(parse(['   ', 'ok']).success).toBe(false);
    expect(parse('not a list').success).toBe(false);
  });

  it('trims the suggestions', () => {
    expect(parse(['  Show more  ', 'Stop']).data).toEqual({ suggestions: ['Show more', 'Stop'] });
  });

  it('echoes them as its result', async () => {
    const tools = followupTools();
    const out = await tools[FOLLOWUPS_TOOL]?.execute?.(
      { suggestions: ['Détail par jour', 'Détail par personne'] } as never,
      { toolCallId: 'c1', messages: [] } as never,
    );
    expect(out).toEqual({ suggestions: ['Détail par jour', 'Détail par personne'] });
  });

  it('is never offered to a background skill run', () => {
    const runSource = readFileSync(new URL('./skill-run.ts', import.meta.url), 'utf8');
    expect(runSource).not.toMatch(/\b(followupTools|buildAgentTools|lastStepWithFollowups)\b/);
  });
});

describe('overview first, details as follow-ups', () => {
  const now = new Date('2026-10-10T12:00:00Z');

  it('is asked of chat replies', () => {
    const prompt = systemPrompt({ now, jiraSites: [], jira: 'full' });
    expect(prompt).toContain('short macro');
    expect(prompt).toContain('Offer the detailed parts as follow-ups');
    expect(prompt).toContain('call suggest_followups last');
  });

  it('is never mentioned to a background skill run', () => {
    const prompt = skillRunPrompt({ now, liveJira: true, sites: [] });
    expect(prompt).not.toContain('suggest_followups');
    expect(prompt).not.toContain('follow-ups');
  });
});
