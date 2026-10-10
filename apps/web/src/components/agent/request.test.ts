import { APICallError, type UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { chatErrorKey, imageErrorKey, toAgentRequest } from './request';

describe('toAgentRequest', () => {
  it('sends only the new user message', () => {
    const messages: UIMessage[] = [
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: ' What is our WIP? ' }] },
    ];
    expect(toAgentRequest('c1', messages)).toEqual({
      conversationId: 'c1',
      message: { id: 'u2', text: 'What is our WIP?' },
    });
  });

  it('sends the images just attached with the text, never stored ones', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const messages: UIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'file', mediaType: 'image/png', url: '/api/agent/attachments/x' }],
      },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'A chart' }] },
      {
        id: 'u2',
        role: 'user',
        parts: [
          { type: 'file', mediaType: 'image/png', url: png },
          { type: 'file', mediaType: 'image/png', url: '/api/agent/attachments/y' },
          { type: 'text', text: 'And this one?' },
        ],
      },
    ];
    expect(toAgentRequest('c1', messages)).toEqual({
      conversationId: 'c1',
      message: { id: 'u2', text: 'And this one?', images: [{ url: png }] },
    });
    const imageOnly: UIMessage = {
      id: 'u3',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/png', url: png }],
    };
    expect(toAgentRequest('c1', [imageOnly])).toEqual({
      conversationId: 'c1',
      message: { id: 'u3', text: '', images: [{ url: png }] },
    });
  });

  it('sends only the decisions just taken, not inputs or outputs', () => {
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-jira_add_comment',
            toolCallId: 't1',
            state: 'approval-responded',
            input: { issueKey: 'DEMO-1', body: 'Hi' },
            approval: { id: 'ap1', approved: false },
          },
          {
            type: 'tool-jira_add_comment',
            toolCallId: 't0',
            state: 'output-available',
            input: { issueKey: 'DEMO-2', body: 'Old' },
            output: 'done',
            approval: { id: 'ap0', approved: true },
          },
        ],
      },
    ] as unknown as UIMessage[];
    expect(toAgentRequest('c1', messages)).toEqual({
      conversationId: 'c1',
      approvals: [{ approvalId: 'ap1', approved: false }],
    });
  });
});

/** What DefaultChatTransport throws for a non-2xx answer of /api/agent/chat. */
const httpError = (statusCode: number, responseBody: string) =>
  new APICallError({
    message: responseBody,
    url: '/api/agent/chat',
    requestBodyValues: undefined,
    statusCode,
    responseBody,
  });

describe('chatErrorKey', () => {
  it.each([
    [401, '{"error":"unauthorized"}', 'unauthorized'],
    [403, '{"error":"forbidden"}', 'forbidden'],
    [413, '{"error":"payload_too_large"}', 'tooLarge'],
    [400, '{"error":"invalid_request"}', 'invalidRequest'],
    [404, '{"error":"not_found"}', 'notFound'],
    [409, '{"error":"turn_in_progress"}', 'turnInProgress'],
    [409, '{"error":"already_decided"}', 'alreadyDecided'],
    [409, '{"error":"approval_not_found"}', 'approvalNotFound'],
    [409, '{"error":"no_llm"}', 'noLlm'],
    [409, '{"error":"duplicate_message"}', 'duplicateMessage'],
    [415, '{"error":"unsupported_image"}', 'unsupportedImage'],
    [413, '{"error":"image_too_large"}', 'imageTooLarge'],
    [400, '{"error":"too_many_images"}', 'tooManyImages'],
    [409, '{"error":"images_not_supported"}', 'imagesNotSupported'],
    // `{ code }` bodies are read too.
    [409, '{"code":"turn_in_progress"}', 'turnInProgress'],
  ])('maps HTTP %i %s to %s', (status, body, key) => {
    expect(chatErrorKey(httpError(status, body))).toBe(key);
  });

  it('falls back on the status when the body is not ours (proxy, HTML error page)', () => {
    expect(chatErrorKey(httpError(401, '<html>login</html>'))).toBe('unauthorized');
    expect(chatErrorKey(httpError(413, ''))).toBe('tooLarge');
    expect(chatErrorKey(httpError(415, ''))).toBe('unsupportedImage');
    expect(chatErrorKey(httpError(409, '{"error":"something_new"}'))).toBe('generic');
  });

  it('is generic for anything else (network failure, a failed answer in the stream)', () => {
    expect(chatErrorKey(httpError(500, 'Internal Server Error'))).toBe('generic');
    expect(chatErrorKey(new TypeError('Failed to fetch'))).toBe('generic');
    expect(chatErrorKey(new Error('{"error":"turn_in_progress"}'))).toBe('generic');
    expect(chatErrorKey(undefined)).toBe('generic');
  });
});

describe('imageErrorKey', () => {
  it('shows the server sentence for a refusal made before sending', () => {
    expect(imageErrorKey('unsupported_image')).toBe('unsupportedImage');
    expect(imageErrorKey('image_too_large')).toBe('imageTooLarge');
    expect(imageErrorKey('too_many_images')).toBe('tooManyImages');
    expect(imageErrorKey('images_not_supported')).toBe('imagesNotSupported');
    expect(imageErrorKey('toString')).toBe('generic');
  });
});
