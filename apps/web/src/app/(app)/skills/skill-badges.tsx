import type { SkillView } from '@agile/skills';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';

/** Trigger, output, sharing and on/off state of a skill, as badges. */
export async function SkillBadges({ skill }: { skill: SkillView }) {
  const t = await getTranslations('skills');
  return (
    <>
      <Badge variant="secondary">{t(`triggers.${skill.trigger}`)}</Badge>
      {skill.trigger !== 'on_demand' && skill.trigger !== 'always' && (
        <Badge variant="outline">{t(`outputs.${skill.output}`)}</Badge>
      )}
      {skill.visibility === 'workspace' && <Badge variant="outline">{t('shared')}</Badge>}
      {!skill.enabled && <Badge variant="destructive">{t('off')}</Badge>}
    </>
  );
}
