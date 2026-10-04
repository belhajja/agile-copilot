import { randomUUID } from 'node:crypto';
import { AgentPage } from '@/components/agent/agent-page';
import { requireActor } from '@/server/context';

export const dynamic = 'force-dynamic';

/** A new chat. Nothing is stored until the first message (the id is only a proposal). */
export default async function NewAgentChatPage() {
  const actor = await requireActor();
  return <AgentPage actor={actor} conversationId={randomUUID()} initialMessages={[]} />;
}
