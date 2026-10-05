/**
 * Every code the skills store and the document parser refuse with: the web UI translates each
 * one (EN/FR tests read these lists). Client-safe (no imports): the web UI imports
 * `@agile/skills/codes`.
 */

/** Why a skill store call was refused (`SkillFailure`). */
export const SKILL_FAILURE_CODES = [
  'not_found',
  'forbidden',
  'invalid',
  'duplicate_name',
  'invalid_channel',
  'forbidden_output',
  'version_conflict',
] as const;
export type SkillFailureCode = (typeof SKILL_FAILURE_CODES)[number];

/** Why a document was refused, per field (`SkillIssue`). */
export const SKILL_ISSUE_CODES = [
  'too_long',
  'missing_frontmatter',
  'invalid_yaml',
  'empty_instructions',
  'required',
  'unknown_field',
  'timezone_invalid',
  'cron_invalid',
  'cron_too_frequent',
  'only_for_schedule',
  'only_for_alert',
  'chat_only',
  'invalid',
] as const;
export type SkillIssueCode = (typeof SKILL_ISSUE_CODES)[number];

/** A skill's trigger and output (`SkillFrontmatter`): the web UI labels them from these lists. */
export const SKILL_TRIGGERS = ['on_demand', 'always', 'schedule', 'alert'] as const;
export const SKILL_OUTPUTS = ['chat', 'dashboard_card', 'email', 'slack', 'teams'] as const;
