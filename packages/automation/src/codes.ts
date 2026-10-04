import type { SkillRunFailure } from '@agile/agent';
import { DELIVERY_CODES } from '@agile/notify/codes';

/**
 * Every code a skill run can end with, every "Run now" answer and every delivery outcome stored on
 * a run: the web UI translates each one (EN/FR tests read these lists), and the code that writes
 * them is typed by them, so a new code fails the typecheck until it is listed here.
 *
 * Client-safe (type imports and `@agile/notify/codes` only): the web UI imports
 * `@agile/automation/codes`.
 */

/** Why a run was recorded as skipped instead of queued (P4-R30). */
export const RUN_SKIP_CODES = ['daily_limit', 'owner_limit', 'user_limit'] as const;
export type RunSkipCode = (typeof RUN_SKIP_CODES)[number];

/** The model run's own failures (`runSkill` in `@agile/agent`). */
export const SKILL_RUN_FAILURE_CODES = [
  'forbidden_role',
  'no_llm',
  'model_failed',
  'empty_output',
] as const satisfies readonly SkillRunFailure[];

// Every SkillRunFailure is listed above (a new code of runSkill fails the typecheck here).
type MissingRunFailure = Exclude<SkillRunFailure, (typeof SKILL_RUN_FAILURE_CODES)[number]>;
const everyRunFailureListed: [MissingRunFailure] extends [never] ? true : MissingRunFailure = true;
void everyRunFailureListed;

/** What the worker ends a run with by itself (`executeSkillRun`, `closeStaleRuns`, the planner). */
export const EXECUTION_RESULT_CODES = [
  'disabled',
  'skill_deleted',
  'owner_left',
  'forbidden_role',
  'invalid_skill',
  'delivery_failed',
  'interrupted',
  'internal_error',
] as const;

/** Every result code a run can be stored with. */
export const RUN_RESULT_CODES = Object.freeze([
  ...new Set([...RUN_SKIP_CODES, ...EXECUTION_RESULT_CODES, ...SKILL_RUN_FAILURE_CODES]),
]) as readonly RunResultCode[];
export type RunResultCode =
  | RunSkipCode
  | (typeof EXECUTION_RESULT_CODES)[number]
  | (typeof SKILL_RUN_FAILURE_CODES)[number];

/** Why "Run now" was refused before anything was recorded (`requestSkillRun`). */
export const RUN_REQUEST_FAILURE_CODES = [
  'not_found',
  'forbidden',
  'not_runnable',
  'disabled',
] as const;
export type RunRequestFailureCode = (typeof RUN_REQUEST_FAILURE_CODES)[number];

/** A run's delivery outcome per output (`email`, `slack`, `teams`): sent, or why not. */
export const DELIVERY_OUTCOMES = [
  'sent',
  'no_channel',
  'no_recipient',
  ...DELIVERY_CODES,
  'delivery_failed',
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];
