import { describe, expect, it } from 'vitest';
import { skillRunPrompt, systemPrompt } from './prompt';
import { CHAT_MAX_STEPS, lastStepWithoutTools } from './steps';

describe('the step budget in the prompts', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  it('asks for broad queries and an answer from what was gathered, in chat and in runs', () => {
    for (const prompt of [
      systemPrompt({ now, jiraSites: [], jira: 'unavailable' }),
      skillRunPrompt({ now, liveJira: false, sites: [] }),
    ]) {
      expect(prompt).toContain('limited number of tool steps');
      expect(prompt).toContain('one broad query');
    }
  });
});

describe('lastStepWithoutTools', () => {
  it('leaves every step but the last one alone', () => {
    const prepare = lastStepWithoutTools(12);
    for (let stepNumber = 0; stepNumber < 11; stepNumber++) {
      expect(prepare({ stepNumber })).toBeUndefined();
    }
  });

  it('takes the tools away on the last step, so the reply ends with an answer', () => {
    expect(lastStepWithoutTools(12)({ stepNumber: 11 })).toEqual({
      activeTools: [],
      toolChoice: 'none',
    });
    expect(lastStepWithoutTools(6)({ stepNumber: 5 })).toEqual({
      activeTools: [],
      toolChoice: 'none',
    });
  });

  it('gives chat replies 12 steps', () => {
    expect(CHAT_MAX_STEPS).toBe(12);
  });
});
