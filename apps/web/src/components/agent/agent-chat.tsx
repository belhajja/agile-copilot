'use client';

import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApprovalCard } from './approval-card';
import { chatErrorKey, toAgentRequest } from './request';
import { ToolCall } from './tool-call';

export function AgentChat({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
}) {
  const t = useTranslations('agent');
  const [text, setText] = useState('');
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/agent/chat',
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: toAgentRequest(id, messages) }),
      }),
    [],
  );
  const { messages, sendMessage, addToolApprovalResponse, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    // After Approve/Reject the decision is sent at once; the server runs (or skips) the change.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const busy = status === 'submitted' || status === 'streaming';

  // A new chat gets its own URL once it exists, so a reload keeps it.
  useEffect(() => {
    if (messages.length > 0 && window.location.pathname === '/agent') {
      window.history.replaceState(null, '', `/agent/${conversationId}`);
    }
  }, [messages.length, conversationId]);

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-96 min-w-0 flex-col gap-3">
      <Conversation className="min-w-0 rounded-lg border">
        <ConversationContent className="gap-6 p-3 sm:p-4">
          {messages.length === 0 && (
            <ConversationEmptyState
              icon={<Bot className="size-8" aria-hidden />}
              title={t('emptyTitle')}
              description={t('emptyHint')}
            />
          )}
          {messages.map((m) => (
            <Message from={m.role} key={m.id} data-role={m.role}>
              <MessageContent className="break-words">
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  if (part.type === 'text') {
                    return m.role === 'assistant' ? (
                      <MessageResponse key={key}>{part.text}</MessageResponse>
                    ) : (
                      <p key={key} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    );
                  }
                  if (!isToolUIPart(part) || part.type === 'dynamic-tool') return null;
                  const name = getToolName(part);
                  return isJiraWriteTool(name) ? (
                    <ApprovalCard
                      key={key}
                      part={part}
                      toolName={name}
                      disabled={busy}
                      onDecision={(id, approved) => addToolApprovalResponse({ id, approved })}
                    />
                  ) : (
                    <ToolCall key={key} part={part} toolName={name} />
                  );
                })}
              </MessageContent>
            </Message>
          ))}
          {status === 'submitted' && <Shimmer>{t('thinking')}</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton aria-label={t('scrollDown')} title={t('scrollDown')} />
      </Conversation>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${chatErrorKey(error)}`)}</AlertDescription>
        </Alert>
      )}
      <PromptInput
        onSubmit={({ text: value }) => {
          const trimmed = value.trim();
          if (!trimmed || busy) return;
          void sendMessage({ text: trimmed });
          setText('');
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            aria-label={t('inputLabel')}
            placeholder={t('placeholder')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </PromptInputBody>
        <PromptInputFooter className="justify-end">
          <PromptInputSubmit
            status={status}
            disabled={busy || !text.trim()}
            aria-label={t('send')}
            title={t('send')}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
