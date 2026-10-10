import { type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';

export const FOLLOWUPS_TOOL = 'suggest_followups';

export const followupsSchema = z.object({
  suggestions: z
    .array(z.string().trim().min(1).max(120))
    .min(2)
    .max(4)
    .describe("2 to 4 next requests, in the user's language, each written as the user's message"),
});

/**
 * `suggest_followups`: next requests the user can send with one click, shown under the answer.
 * Chat only; it touches nothing and only echoes what the model wrote.
 */
export function followupTools(): ToolSet {
  return {
    [FOLLOWUPS_TOOL]: tool({
      description:
        'Offer the user 2 to 4 follow-up requests as buttons under your answer. Call it last, after your answer.',
      inputSchema: followupsSchema,
      execute: async ({ suggestions }) => ({ suggestions }),
    }) as Tool,
  };
}
