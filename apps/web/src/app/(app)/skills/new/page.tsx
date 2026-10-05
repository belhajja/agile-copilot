import { loadConversation } from '@agile/agent';
import { canManageConnections } from '@agile/auth';
import { listDeliveryChannels } from '@agile/notify';
import { serializeSkill } from '@agile/skills';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { requireActor, services } from '@/server/context';
import { SkillEditor } from '../skill-editor';
import { findSkillSuggestion } from './suggestion';

type Query = string | string[] | undefined;
const single = (v: Query) => (typeof v === 'string' ? v : undefined);

/**
 * A new skill: describe it in your words (the AI drafts it), or write the SKILL.md directly.
 * `?from=<conversation>&suggestion=<tool call>` starts from a skill the assistant suggested in one
 * of the user's own conversations, read from the stored tool result (never from the URL).
 */
export default async function NewSkillPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: Query; suggestion?: Query }>;
}) {
  const actor = await requireActor();
  const t = await getTranslations('skills.editor');
  const canPostToChannels = canManageConnections(actor.roles);
  const channels = canPostToChannels ? await listDeliveryChannels(services().db, actor.orgId) : [];
  const template = serializeSkill({
    frontmatter: { name: 'my-skill', description: t('templateDescription'), trigger: 'on_demand' },
    instructions: t('templateInstructions'),
  });

  const query = await searchParams;
  const asked = query.from !== undefined || query.suggestion !== undefined;
  const from = single(query.from);
  const callId = single(query.suggestion);
  const conversation = from && callId ? await loadConversation(services().db, actor, from) : null;
  const suggested =
    conversation && callId ? findSkillSuggestion(conversation.messages, callId) : null;

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('newTitle')}</h1>
        <p className="text-muted-foreground">{t('newIntro')}</p>
      </div>
      {asked && (
        <Alert
          data-suggestion={suggested ? 'loaded' : 'missing'}
          variant={suggested ? 'default' : 'destructive'}
        >
          <AlertDescription>
            {t(suggested ? 'fromSuggestion' : 'suggestionNotFound')}
          </AlertDescription>
        </Alert>
      )}
      <SkillEditor
        initialDocument={suggested ?? template}
        channels={channels.map(({ id, name, kind }) => ({ id, name, kind }))}
        initialChannelId={null}
        canPostToChannels={canPostToChannels}
      />
    </div>
  );
}
