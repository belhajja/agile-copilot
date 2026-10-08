import { describe, expect, it } from 'vitest';
import { MESSAGE_MAX_LENGTH } from './limits';
import { agentRequestSchema } from './turn';

describe('chat message limit', () => {
  it('is what the request schema accepts', () => {
    const body = (text: string) => ({
      conversationId: '5b7c9b64-d4eb-4210-8ab7-4be8bf3e6aee',
      message: { id: 'm1', text },
    });
    expect(agentRequestSchema.safeParse(body('x'.repeat(MESSAGE_MAX_LENGTH))).success).toBe(true);
    expect(agentRequestSchema.safeParse(body('x'.repeat(MESSAGE_MAX_LENGTH + 1))).success).toBe(
      false,
    );
  });
});
