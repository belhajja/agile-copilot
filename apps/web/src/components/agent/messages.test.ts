import { TOOL_ERROR_CODES } from '@agile/agent/tool-errors';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import fr from '../../../messages/fr.json';

const locales = { en, fr } as const;

describe('assistant texts (EN/FR)', () => {
  it.each(Object.entries(locales))(
    '%s has a sentence for every tool error code the agent can report',
    (_locale, messages) => {
      const toolErrors = messages.agent.toolErrors as Record<string, string>;
      const missing = TOOL_ERROR_CODES.filter(
        (code) => typeof toolErrors[code] !== 'string' || !toolErrors[code]?.trim(),
      );
      expect(missing).toEqual([]);
    },
  );

  it.each(Object.entries(locales))(
    '%s tells the user what to do when a decision or a message cannot be sent',
    (_locale, messages) => {
      const agent = messages.agent as Record<string, unknown>;
      for (const key of ['notSent', 'tooLong', 'unknownSite']) {
        expect(typeof agent[key]).toBe('string');
      }
    },
  );
});
