import { listConversations } from '@agile/agent';
import { listLlmConnections } from '@agile/connections';
import type { UIMessage } from 'ai';
import { Bot, MessageSquarePlus } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { connectionDeps, type SessionActor, services } from '@/server/context';
import { AgentChat } from './agent-chat';

/** The assistant page: past conversations, then the chat (or how to connect a model first). */
export async function AgentPage({
  actor,
  conversationId,
  initialMessages,
}: {
  actor: SessionActor;
  conversationId: string;
  initialMessages: UIMessage[];
}) {
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const [llms, conversations] = await Promise.all([
    listLlmConnections(connectionDeps(), actor.orgId),
    listConversations(services().db, actor, 10),
  ]);
  if (!llms.some((c) => c.isDefault)) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>{t('noModel')}</EmptyTitle>
          <EmptyDescription>{t('noModelHint')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/settings/llm">{t('connectModel')}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const recent = conversations.filter((c) => c.id !== conversationId && c.title).slice(0, 5);
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">{t('title')}</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/agent">
            <MessageSquarePlus aria-hidden />
            {t('newChat')}
          </Link>
        </Button>
        {recent.length > 0 && (
          <nav
            aria-label={t('history')}
            className="flex w-full min-w-0 gap-2 overflow-x-auto md:order-first md:w-auto md:flex-1"
          >
            {recent.map((c) => (
              <Button key={c.id} asChild variant="ghost" size="sm" className="max-w-48 shrink-0">
                <Link href={`/agent/${c.id}`} title={format.dateTime(c.updatedAt)}>
                  <span className="truncate">{c.title}</span>
                </Link>
              </Button>
            ))}
          </nav>
        )}
      </div>
      <AgentChat
        key={conversationId}
        conversationId={conversationId}
        initialMessages={initialMessages}
      />
    </div>
  );
}
