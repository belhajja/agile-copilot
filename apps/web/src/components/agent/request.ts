import { APICallError, isToolUIPart, type UIMessage } from 'ai';

/**
 * The body the chat sends to /api/agent/chat: the new user message, or the decisions the user just
 * took on proposed Jira changes. Never the history: the server keeps it.
 */
export function toAgentRequest(conversationId: string, messages: UIMessage[]) {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const text = last.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n')
      .trim();
    return { conversationId, message: { id: last.id, text } };
  }
  const approvals = (last?.parts ?? []).flatMap((p) =>
    isToolUIPart(p) && p.state === 'approval-responded' && p.approval
      ? [{ approvalId: p.approval.id, approved: p.approval.approved === true }]
      : [],
  );
  return { conversationId, approvals };
}

/** The `agent.errors.*` message shown for a failed chat request. */
export type ChatErrorKey =
  | 'unauthorized'
  | 'forbidden'
  | 'tooLarge'
  | 'invalidRequest'
  | 'notFound'
  | 'turnInProgress'
  | 'alreadyDecided'
  | 'approvalNotFound'
  | 'noLlm'
  | 'insecureLlm'
  | 'duplicateMessage'
  | 'generic';

// The codes /api/agent/chat (and proxy.ts) answer with, as `{ error: code }`.
const BY_CODE: Record<string, ChatErrorKey> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  payload_too_large: 'tooLarge',
  invalid_request: 'invalidRequest',
  not_found: 'notFound',
  turn_in_progress: 'turnInProgress',
  already_decided: 'alreadyDecided',
  approval_not_found: 'approvalNotFound',
  no_llm: 'noLlm',
  insecure_llm: 'insecureLlm',
  duplicate_message: 'duplicateMessage',
};
// When the body is not ours (an HTML error page): only statuses with one meaning.
const BY_STATUS: Record<number, ChatErrorKey> = {
  400: 'invalidRequest',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'notFound',
  413: 'tooLarge',
};

function codeOf(body: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(body ?? '') as { error?: unknown; code?: unknown } | null;
    const code = parsed?.error ?? parsed?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which translated message to show for a failed chat request. DefaultChatTransport throws an
 * `APICallError` (status + body) for HTTP errors; anything else (network, a failed answer in the
 * stream) is generic. The server's body is never shown as is.
 */
export function chatErrorKey(error: unknown): ChatErrorKey {
  if (!APICallError.isInstance(error)) return 'generic';
  const code = codeOf(error.responseBody);
  if (code !== undefined) return (Object.hasOwn(BY_CODE, code) && BY_CODE[code]) || 'generic';
  return (error.statusCode !== undefined && BY_STATUS[error.statusCode]) || 'generic';
}
