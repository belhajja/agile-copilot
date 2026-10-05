import { listConversations } from '@agile/agent';
import { listJiraConnections, listLlmConnections } from '@agile/connections';
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
import { cn } from '@/lib/utils';
import { connectionDeps, type SessionActor, services } from '@/server/context';
import { AgentChat } from './agent-chat';

/**
 * The assistant page: past conversations on the left (above the chat on small screens), then the
 * chat (or how to connect a model first).
 */
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
  const [llms, conversations, jiraSites] = await Promise.all([
    listLlmConnections(connectionDeps(), actor.orgId),
    listConversations(services().db, actor),
    listJiraConnections(connectionDeps(), actor.orgId),
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
  // Untitled conversations have no answer yet: nothing worth reopening.
  const history = conversations.filter((c) => c.title);
  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-[16rem_minmax(0,1fr)] md:gap-4">
      {/* Same height as the chat on wide screens, so the list scrolls on its own. */}
      <aside className="flex min-w-0 flex-col gap-2 md:h-[calc(100dvh-9rem)] md:min-h-96">
        <div className="flex items-center gap-2">
          <h1 className="mr-auto text-xl font-semibold tracking-tight">{t('title')}</h1>
          <Button asChild variant="outline" size="sm">
            <Link href="/agent">
              <MessageSquarePlus aria-hidden />
              {t('newChat')}
            </Link>
          </Button>
        </div>
        {history.length > 0 && (
          <nav
            aria-label={t('history')}
            className="grid max-h-40 content-start gap-1 overflow-y-auto md:max-h-none md:flex-1"
          >
            {history.map((c) => {
              const current = c.id === conversationId;
              return (
                <Link
                  key={c.id}
                  href={`/agent/${c.id}`}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'grid min-w-0 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                    current && 'bg-muted font-medium',
                  )}
                >
                  <span className="truncate">{c.title}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {format.dateTime(c.updatedAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </Link>
              );
            })}
          </nav>
        )}
      </aside>
      <AgentChat
        key={conversationId}
        conversationId={conversationId}
        initialMessages={initialMessages}
        siteNames={Object.fromEntries(jiraSites.map((s) => [s.id, s.name]))}
      />
    </div>
  );
}
