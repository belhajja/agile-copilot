import { type ConversationSummary, listConversationHistory } from '@agile/agent';
import { canManageConnections } from '@agile/auth';
import { listJiraConnections, listLlmConnections } from '@agile/connections';
import { listSelectedBoards } from '@agile/sync';
import type { UIMessage } from 'ai';
import { Bot } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getNow, getTimeZone, getTranslations } from 'next-intl/server';
import { BoardSitesProvider } from '@/components/jira-issue-link';
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
import { syncDeps } from '@/server/sync';
import { AgentChat } from './agent-chat';
import { AgentShell } from './agent-shell';
import { groupConversations } from './group-conversations';
import type { HistoryItem } from './history-list';
import { ModelPicker } from './model-picker';

/** The assistant page: past conversations beside the chat (or how to connect a model first). */
export async function AgentPage({
  actor,
  conversationId,
  initialMessages,
  conversation,
}: {
  actor: SessionActor;
  conversationId: string;
  initialMessages: UIMessage[];
  /** What is stored about it; absent for a new chat. */
  conversation?: { llmConnectionId: string | null; groupId: string | null; archived: boolean };
}) {
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const [llms, history, jiraSites, boards, now, timeZone] = await Promise.all([
    listLlmConnections(connectionDeps(), actor.orgId),
    listConversationHistory(services().db, actor),
    listJiraConnections(connectionDeps(), actor.orgId),
    listSelectedBoards(syncDeps(), actor.orgId),
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
  const item =
    (place: { groupId: string | null; archived: boolean }) =>
    (c: ConversationSummary): HistoryItem => ({
      id: c.id,
      title: c.title,
      when: format.dateTime(c.updatedAt, { dateStyle: 'medium', timeStyle: 'short' }),
      ...place,
    });
  const sidebar = {
    folders: history.groups.map((g) => ({
      id: g.id,
      name: g.name,
      items: g.conversations.map(item({ groupId: g.id, archived: false })),
    })),
    dated: groupConversations(history.recent, now, timeZone).map((g) => ({
      key: g.key,
      items: g.items.map(item({ groupId: null, archived: false })),
    })),
    archived: history.archived.map(item({ groupId: null, archived: true })),
  };
  // Working models only: a failing one would not answer anyway.
  const models = llms
    .filter((c) => c.isDefault || c.status !== 'error')
    .map((c) => ({ id: c.id, label: c.label, model: c.model, isDefault: c.isDefault }));
  const pickedId = conversation?.llmConnectionId ?? null;
  const fallback = pickedId !== null && !models.some((m) => m.id === pickedId);
  const siteUrls: Record<string, string> = Object.fromEntries(
    jiraSites.map((s) => [s.id, s.baseUrl]),
  );
  const boardSites = Object.fromEntries(
    boards.flatMap((b) => {
      const url = siteUrls[b.connectionId];
      return url ? [[b.id, url] as const] : [];
    }),
  );
  return (
    <AgentShell
      history={sidebar}
      currentId={conversationId}
      headerActions={
        <ModelPicker
          conversationId={conversationId}
          models={models}
          pickedId={pickedId}
          fallback={fallback}
          canManage={canManageConnections(actor.roles)}
        />
      }
    >
      <BoardSitesProvider sites={boardSites}>
        <AgentChat
          key={conversationId}
          conversationId={conversationId}
          initialMessages={initialMessages}
          siteNames={Object.fromEntries(jiraSites.map((s) => [s.id, s.name]))}
          siteUrls={siteUrls}
        />
      </BoardSitesProvider>
    </AgentShell>
  );
}
