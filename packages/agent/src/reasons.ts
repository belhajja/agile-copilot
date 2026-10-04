/**
 * Why a proposed Jira change was closed without the user's yes. The stored approval (and what the
 * model reads) carries the fixed sentence; the UI maps it back to the code with `decisionReasonOf`.
 *
 * Client-safe (no imports): the web UI imports `@agile/agent/reasons`.
 */
export type DecisionReason = 'superseded' | 'forbidden_role';

/** What the model is told when a proposal closes for a reason (fixed sentences). */
export const REASON_TEXT: Readonly<Record<DecisionReason, string>> = Object.freeze({
  superseded: 'The user moved on without approving.',
  forbidden_role:
    'Not approved: Jira changes are not available for this user’s role (forbidden_role).',
});

/** The reason code of a stored `approval.reason` sentence; undefined for anything else. */
export function decisionReasonOf(text: unknown): DecisionReason | undefined {
  if (typeof text !== 'string') return undefined;
  return (Object.keys(REASON_TEXT) as DecisionReason[]).find((r) => REASON_TEXT[r] === text);
}
