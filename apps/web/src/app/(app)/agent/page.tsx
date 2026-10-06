import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { requireActor } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * A new chat gets its id in the URL straight away: refreshes (a server action elsewhere, a reload)
 * keep the same conversation. Nothing is stored until the first message or a model choice.
 */
export default async function NewAgentChatPage() {
  await requireActor();
  redirect(`/agent/${randomUUID()}`);
}
