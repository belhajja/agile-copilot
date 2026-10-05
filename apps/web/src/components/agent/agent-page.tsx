import { listConversations } from '@agile/agent';
import { listJiraConnections, listLlmConnections } from '@agile/connections';
import type { UIMessage } from 'ai';
import { Bot } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getNow, getTimeZone, getTranslations } from 'next-intl/server';
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
import { AgentShell } from './agent-shell';
import { groupConversations } from './group-conversations';

/** The assistant page: past conversations beside the chat (or how to connect a model first). */
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
  const [llms, conversations, jiraSites, now, timeZone] = await Promise.all([
    listLlmConnections(connectionDeps(), actor.orgId),
    listConversations(services().db, actor),
    listJiraConnections(connectionDeps(), actor.orgId),
    getNow(),
    getTimeZone(),
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
  const groups = groupConversations(
    conversations.filter((c) => c.title),
    now,
    timeZone,
  ).map((g) => ({
    key: g.key,
    items: g.items.map((c) => ({
      id: c.id,
      title: c.title ?? '',
      when: format.dateTime(c.updatedAt, { dateStyle: 'medium', timeStyle: 'short' }),
    })),
  }));
  return (
    <AgentShell groups={groups} currentId={conversationId}>
      <AgentChat
        key={conversationId}
        conversationId={conversationId}
        initialMessages={initialMessages}
        siteNames={Object.fromEntries(jiraSites.map((s) => [s.id, s.name]))}
      />
    </AgentShell>
  );
}
