import { describe, expect, it } from 'vitest';
import { skillRunPrompt, systemPrompt } from './prompt';
import {
  CHAT_MAX_STEPS,
  chatOutputTokens,
  followupsOffered,
  LAST_STEP_INSTRUCTIONS,
  lastStepWithFollowups,
  lastStepWithoutTools,
  replyDeadlineMs,
  turnLeaseSeconds,
} from './steps';

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

describe('the answer budget and the reply deadline', () => {
  it('uses the model’s budget, else 16 000 tokens', () => {
    expect(chatOutputTokens(null)).toBe(16_000);
    expect(chatOutputTokens(48_000)).toBe(48_000);
  });

  it('gives a reply the time to write its budget at 60 tokens a second', () => {
    expect(replyDeadlineMs(24_000)).toBe(400_000);
    expect(replyDeadlineMs(36_000)).toBe(600_000);
  });

  it('never less than 5 minutes, never more than 15', () => {
    expect(replyDeadlineMs(1_000)).toBe(300_000);
    expect(replyDeadlineMs(16_000)).toBe(300_000);
    expect(replyDeadlineMs(18_000)).toBe(300_000);
    expect(replyDeadlineMs(54_000)).toBe(900_000);
    expect(replyDeadlineMs(64_000)).toBe(900_000);
  });

  it('holds the conversation for twice the deadline: 10 to 30 minutes', () => {
    expect(turnLeaseSeconds(replyDeadlineMs(16_000))).toBe(600);
    expect(turnLeaseSeconds(replyDeadlineMs(64_000))).toBe(1_800);
    expect(turnLeaseSeconds(1_500)).toBe(3);
  });
});

describe('lastStepWithFollowups (chat replies)', () => {
  it('leaves every step but the last one alone', () => {
    const prepare = lastStepWithFollowups(12);
    for (let stepNumber = 0; stepNumber < 11; stepNumber++) {
      expect(prepare({ stepNumber, instructions: 'System.' })).toBeUndefined();
    }
  });

  it('offers only suggest_followups on the last step, and says it is the last', () => {
    expect(lastStepWithFollowups(12)({ stepNumber: 11, instructions: 'System.' })).toEqual({
      activeTools: ['suggest_followups'],
      toolChoice: 'auto',
      instructions: `System.

${LAST_STEP_INSTRUCTIONS}`,
    });
    expect(LAST_STEP_INSTRUCTIONS).toContain('This is your last step');
    expect(LAST_STEP_INSTRUCTIONS).toContain('suggest_followups');
  });
});

describe('followupsOffered', () => {
  const step = (text: string, ...tools: string[]) => ({
    text,
    toolCalls: tools.map((toolName) => ({ toolName })),
  });
  const offered = (...steps: ReturnType<typeof step>[]) =>
    followupsOffered({ steps } as unknown as Parameters<typeof followupsOffered>[0]);

  it('ends a reply once its last step only offered follow-ups after an answer', () => {
    expect(offered(step('', 'list_boards'), step('Velocity is 19.', 'suggest_followups'))).toBe(
      true,
    );
    expect(offered(step('Velocity is 19.'), step('', 'suggest_followups'))).toBe(true);
  });

  it('goes on otherwise', () => {
    expect(offered(step('', 'list_boards'))).toBe(false);
    expect(offered(step('Here:', 'suggest_followups', 'get_metric'))).toBe(false);
    // Follow-ups before any answer: the model still owes one.
    expect(offered(step('', 'suggest_followups'))).toBe(false);
    expect(offered(step('Done.'))).toBe(false);
  });
});
