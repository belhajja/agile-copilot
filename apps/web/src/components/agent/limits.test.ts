import { agentRequestSchema } from '@agile/agent';
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH } from './limits';

describe('chat message limit', () => {
  it('is the server’s limit', () => {
    const body = (text: string) => ({
      conversationId: '5b7c9b64-d4eb-4210-8ab7-4be8bf3e6aee',
      message: { id: 'm1', text },
    });
    expect(agentRequestSchema.safeParse(body('x'.repeat(MAX_MESSAGE_LENGTH))).success).toBe(true);
    expect(agentRequestSchema.safeParse(body('x'.repeat(MAX_MESSAGE_LENGTH + 1))).success).toBe(
      false,
    );
  });
});
