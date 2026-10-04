import { canManageConnections } from '@agile/auth';
import { listDeliveryChannels } from '@agile/notify';
import { serializeSkill } from '@agile/skills';
import { getTranslations } from 'next-intl/server';
import { requireActor, services } from '@/server/context';
import { SkillEditor } from '../skill-editor';

/** A new skill: describe it in your words (the AI drafts it), or write the SKILL.md directly. */
export default async function NewSkillPage() {
  const actor = await requireActor();
  const t = await getTranslations('skills.editor');
  const canPostToChannels = canManageConnections(actor.roles);
  const channels = canPostToChannels ? await listDeliveryChannels(services().db, actor.orgId) : [];
  const template = serializeSkill({
    frontmatter: { name: 'my-skill', description: t('templateDescription'), trigger: 'on_demand' },
    instructions: t('templateInstructions'),
  });
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('newTitle')}</h1>
        <p className="text-muted-foreground">{t('newIntro')}</p>
      </div>
      <SkillEditor
        initialDocument={template}
        channels={channels.map(({ id, name, kind }) => ({ id, name, kind }))}
        initialChannelId={null}
        canPostToChannels={canPostToChannels}
      />
    </div>
  );
}
