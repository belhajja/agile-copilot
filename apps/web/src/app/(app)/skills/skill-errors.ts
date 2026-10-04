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

/** "Run now" outcomes shown on a skill's page (`?run=`, `skills.runRequest.*`). */
export const RUN_REQUEST_CODES = [
  'queued',
  'daily_limit',
  'not_found',
  'forbidden',
  'not_runnable',
] as const;

/** Codes the skill builder has a message for (`skills.editor.errors.*`). */
export const EDITOR_ERROR_CODES = [
  'not_found',
  'forbidden',
  'invalid',
  'duplicate_name',
  'invalid_channel',
  'forbidden_output',
  'version_conflict',
  'forbidden_role',
  'no_llm',
  'model_failed',
  'empty_output',
  'invalid_request',
  'rate_limited',
] as const;

/** Document issues the builder translates per field (`skills.editor.issues.*`). */
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

/** Stored run result codes (`skills.resultCodes.*`). */
export const RUN_RESULT_CODES = [
  'daily_limit',
  'disabled',
  'owner_left',
  'forbidden_role',
  'invalid_skill',
  'no_llm',
  'model_failed',
  'empty_output',
  'delivery_failed',
  'interrupted',
  'internal_error',
] as const;

/** Outputs that deliver somewhere, as stored in a run's delivery outcomes. */
export const DELIVERY_OUTPUTS = ['email', 'slack', 'teams'] as const;

/** Stored delivery outcomes (`skills.deliveryOutcomes.*`). */
export const DELIVERY_OUTCOMES = [
  'sent',
  'no_channel',
  'no_recipient',
  'blocked_url',
  'insecure_transport',
  'unreachable',
  'rejected',
  'timeout',
  'auth_failed',
  'invalid_channel',
  'delivery_failed',
] as const;
