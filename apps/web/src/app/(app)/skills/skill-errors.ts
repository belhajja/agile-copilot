import {
  DELIVERY_OUTCOMES as RUN_DELIVERY_OUTCOMES,
  RUN_REQUEST_FAILURE_CODES,
  RUN_SKIP_CODES,
  SKILL_RUN_FAILURE_CODES,
  RUN_RESULT_CODES as STORED_RUN_RESULT_CODES,
} from '@agile/automation/codes';
import {
  SKILL_ISSUE_CODES as DOCUMENT_ISSUE_CODES,
  SKILL_FAILURE_CODES,
} from '@agile/skills/codes';
import { pickCode } from '@/lib/error-code';

/**
 * The codes the Skills pages translate, derived from the packages' own lists (M10): a code added
 * there is shown with its message (the EN/FR test fails until both locales have it), never as
 * "unknown". Client-safe: the `codes` entries have no runtime dependencies.
 */

/** The codes the Skills pages have a translated message for (`skills.errors.*`). */
export const SKILL_ERROR_CODES = [...SKILL_FAILURE_CODES, 'not_runnable'] as const;

export const SKILL_TABS = ['mine', 'library', 'shared'] as const;
export type SkillTab = (typeof SKILL_TABS)[number];

/** "Run now" outcomes shown on a skill's page (`?run=`, `skills.runRequest.*`). */
export const RUN_REQUEST_CODES = [
  'queued',
  ...RUN_SKIP_CODES,
  ...RUN_REQUEST_FAILURE_CODES,
] as const;

/** Codes the skill builder has a message for (`skills.editor.errors.*`). */
export const EDITOR_ERROR_CODES = [
  ...new Set([
    ...SKILL_FAILURE_CODES,
    ...SKILL_RUN_FAILURE_CODES,
    'invalid_request',
    'rate_limited',
  ] as const),
];

/** Document issues the builder translates per field (`skills.editor.issues.*`). */
export const SKILL_ISSUE_CODES = DOCUMENT_ISSUE_CODES;

/** Stored run result codes (`skills.resultCodes.*`). */
export const RUN_RESULT_CODES = STORED_RUN_RESULT_CODES;

/** Outputs that deliver somewhere, as stored in a run's delivery outcomes. */
export const DELIVERY_OUTPUTS = ['email', 'slack', 'teams'] as const;

/** Stored delivery outcomes (`skills.deliveryOutcomes.*`). */
export const DELIVERY_OUTCOMES = RUN_DELIVERY_OUTCOMES;

/** Result codes about delivery or the owner's role are the owner's business: others see "failed". */
const OTHERS_RESULT_CODES = RUN_RESULT_CODES.filter(
  (c) => c !== 'delivery_failed' && c !== 'forbidden_role',
);

/**
 * The result code a run shows to this viewer (`resultCodes.*`), or null for none. Others see one
 * status per run (M7): nothing more on a succeeded run (its delivery is the owner's business, P4-R1),
 * and "failed" instead of a code that is the owner's business.
 */
export function visibleResultCode(
  run: { status: string; resultCode: string | null },
  isOwner: boolean,
): string | null {
  if (!run.resultCode) return null;
  if (isOwner) return pickCode(run.resultCode, RUN_RESULT_CODES);
  if (run.status === 'succeeded') return null;
  return pickCode(run.resultCode, OTHERS_RESULT_CODES);
}
