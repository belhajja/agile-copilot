import { loadConversation } from '@agile/agent';
import { notFound } from 'next/navigation';
import { AgentPage } from '@/components/agent/agent-page';
import { requireActor, services } from '@/server/context';

export default async function AgentConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const actor = await requireActor();
  const { conversationId } = await params;
  const conversation = await loadConversation(services().db, actor, conversationId);
  if (!conversation) notFound();
  return (
    <AgentPage
      actor={actor}
      conversationId={conversation.id}
      initialMessages={conversation.messages}
      conversation={conversation}
    />
  );
}
