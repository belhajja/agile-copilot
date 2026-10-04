/** The codes the Skills pages have a translated message for (`skills.errors.*`). */
export const SKILL_ERROR_CODES = [
  'not_found',
  'forbidden',
  'invalid',
  'duplicate_name',
  'invalid_channel',
  'forbidden_output',
  'version_conflict',
  'not_runnable',
] as const;

export const SKILL_TABS = ['mine', 'library', 'shared'] as const;
export type SkillTab = (typeof SKILL_TABS)[number];
