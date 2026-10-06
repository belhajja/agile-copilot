import { describe, expect, it } from 'vitest';
import {
  canShowModelList,
  initialSelection,
  OTHER_MODEL,
  pickingStateFromLoad,
} from './model-picker';

describe('canShowModelList', () => {
  it('is false for an empty list (a <select> with only "Other…" would auto-select it)', () => {
    expect(canShowModelList([])).toBe(false);
  });

  it('is true once there is at least one model', () => {
    expect(canShowModelList(['claude-sonnet-5-5'])).toBe(true);
  });
});

describe('initialSelection', () => {
  it('keeps the current model when the list still offers it', () => {
    expect(initialSelection(['a', 'b'], 'b')).toBe('b');
  });

  it('falls back to the first model when the current one is not listed', () => {
    expect(initialSelection(['a', 'b'], 'z')).toBe('a');
  });

  it('falls back to the current value when the list is empty', () => {
    expect(initialSelection([], 'z')).toBe('z');
  });
});

describe('pickingStateFromLoad', () => {
  it('falls back to free text, never __other__ as a real choice, when the list is empty', () => {
    const state = pickingStateFromLoad({ ok: true, models: [] }, 'current-model');
    expect(state).toEqual({ models: [], selected: 'current-model', other: true });
    expect(state.selected).not.toBe(OTHER_MODEL);
  });

  it('shows the list and preselects the current model when it is still offered', () => {
    const state = pickingStateFromLoad({ ok: true, models: ['a', 'b'] }, 'b');
    expect(state).toEqual({ models: ['a', 'b'], selected: 'b', other: false });
  });

  it('falls back to free text on any failure, carrying the error (never a dead end)', () => {
    const state = pickingStateFromLoad({ ok: false, code: 'provider_error' }, 'current-model');
    expect(state).toEqual({
      models: [],
      selected: 'current-model',
      other: true,
      error: { code: 'provider_error', reason: undefined, host: undefined },
    });
  });

  it('carries the blocked_url reason and host through for the form to translate', () => {
    const state = pickingStateFromLoad(
      { ok: false, code: 'blocked_url', reason: 'private_address', host: 'h' },
      'current-model',
    );
    expect(state.error).toEqual({ code: 'blocked_url', reason: 'private_address', host: 'h' });
    expect(state.other).toBe(true);
  });
});
