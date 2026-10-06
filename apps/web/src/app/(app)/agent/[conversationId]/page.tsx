import { isConversationId, loadConversation } from '@agile/agent';
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
  if (!isConversationId(conversationId)) notFound();
  // Not stored yet (a new chat, or an id that is not the user's): an empty chat under that id.
  const conversation = await loadConversation(services().db, actor, conversationId);
  return (
    <AgentPage
      actor={actor}
      conversationId={conversationId}
      initialMessages={conversation?.messages ?? []}
      conversation={conversation ?? undefined}
    />
  );
}
