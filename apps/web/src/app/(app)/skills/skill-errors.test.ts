import {
  DELIVERY_OUTCOMES as PACKAGE_DELIVERY_OUTCOMES,
  RUN_RESULT_CODES as PACKAGE_RUN_RESULT_CODES,
  RUN_REQUEST_FAILURE_CODES,
  RUN_SKIP_CODES,
  SKILL_RUN_FAILURE_CODES,
} from '@agile/automation/codes';
import { CHANNEL_FAILURE_CODES } from '@agile/notify/codes';
import { SKILL_ISSUE_CODES as PACKAGE_ISSUE_CODES, SKILL_FAILURE_CODES } from '@agile/skills/codes';
import { describe, expect, it } from 'vitest';
import en from '../../../../messages/en.json';
import fr from '../../../../messages/fr.json';
import { CHANNEL_ERROR_CODES } from '../settings/delivery/error-codes';
import {
  DELIVERY_OUTCOMES,
  DELIVERY_OUTPUTS,
  EDITOR_ERROR_CODES,
  RUN_REQUEST_CODES,
  RUN_RESULT_CODES,
  SKILL_ERROR_CODES,
  SKILL_ISSUE_CODES,
  visibleResultCode,
} from './skill-errors';

const at = (root: unknown, path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], root);

/** The codes of `codes` that have no non-empty sentence under `group` (plus `unknown`). */
const untranslated = (messages: unknown, group: string, codes: readonly string[]) =>
  [...codes, 'unknown'].filter((c) => {
    const text = at(messages, `${group}.${c}`);
    return typeof text !== 'string' || !text.trim();
  });

describe('skill and delivery codes (M10)', () => {
  it('derives every web list from the packages’ lists', () => {
    expect(SKILL_ERROR_CODES).toEqual(expect.arrayContaining([...SKILL_FAILURE_CODES]));
    expect(EDITOR_ERROR_CODES).toEqual(
      expect.arrayContaining([...SKILL_FAILURE_CODES, ...SKILL_RUN_FAILURE_CODES]),
    );
    expect(RUN_REQUEST_CODES).toEqual(
      expect.arrayContaining(['queued', ...RUN_SKIP_CODES, ...RUN_REQUEST_FAILURE_CODES]),
    );
    expect(RUN_RESULT_CODES).toEqual(PACKAGE_RUN_RESULT_CODES);
    expect(DELIVERY_OUTCOMES).toEqual(PACKAGE_DELIVERY_OUTCOMES);
    expect(SKILL_ISSUE_CODES).toEqual(PACKAGE_ISSUE_CODES);
    expect(CHANNEL_ERROR_CODES).toEqual(expect.arrayContaining([...CHANNEL_FAILURE_CODES]));
  });

  it.each(Object.entries({ en, fr }))('%s has a sentence for every code', (_locale, messages) => {
    expect({
      errors: untranslated(messages, 'skills.errors', SKILL_ERROR_CODES),
      editor: untranslated(messages, 'skills.editor.errors', EDITOR_ERROR_CODES),
      issues: untranslated(messages, 'skills.editor.issues', SKILL_ISSUE_CODES),
      runRequest: untranslated(messages, 'skills.runRequest', RUN_REQUEST_CODES),
      resultCodes: untranslated(messages, 'skills.resultCodes', RUN_RESULT_CODES),
      deliveryOutcomes: untranslated(messages, 'skills.deliveryOutcomes', DELIVERY_OUTCOMES),
      outputs: untranslated(messages, 'skills.outputs', DELIVERY_OUTPUTS).filter(
        (c) => c !== 'unknown',
      ),
      channels: untranslated(messages, 'delivery.errors', CHANNEL_ERROR_CODES),
    }).toEqual({
      errors: [],
      editor: [],
      issues: [],
      runRequest: [],
      resultCodes: [],
      deliveryOutcomes: [],
      outputs: [],
      channels: [],
    });
  });
});

describe('the result code a run shows (M7, P4-R1)', () => {
  it('shows the owner every code', () => {
    expect(visibleResultCode({ status: 'succeeded', resultCode: 'delivery_failed' }, true)).toBe(
      'delivery_failed',
    );
    expect(visibleResultCode({ status: 'skipped', resultCode: 'user_limit' }, true)).toBe(
      'user_limit',
    );
  });

  it('shows others one status per run: nothing more on a succeeded run', () => {
    expect(
      visibleResultCode({ status: 'succeeded', resultCode: 'delivery_failed' }, false),
    ).toBeNull();
    expect(visibleResultCode({ status: 'failed', resultCode: 'forbidden_role' }, false)).toBe(
      'unknown',
    );
    expect(visibleResultCode({ status: 'skipped', resultCode: 'daily_limit' }, false)).toBe(
      'daily_limit',
    );
    expect(visibleResultCode({ status: 'failed', resultCode: null }, false)).toBeNull();
  });

  it.each(['constructor', '__proto__', 'toString'])('maps %s to unknown', (code) => {
    expect(visibleResultCode({ status: 'failed', resultCode: code }, true)).toBe('unknown');
  });
});
