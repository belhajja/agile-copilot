import { describe, expect, it } from 'vitest';
import { afterResult, type EditorState, frontmatterOutput, postsToChannel } from './editor-state';

const state: EditorState = {
  document: 'mine',
  drafted: false,
  preview: null,
  version: 2,
  result: null,
};

describe('the skill editor state (M1)', () => {
  it('puts a draft in the editor, marked as a draft to review, without saving it', () => {
    const next = afterResult(state, 'draft', { ok: true, document: 'drafted' });
    expect(next).toMatchObject({ document: 'drafted', drafted: true, version: 2 });
  });

  it('keeps the text when a draft fails', () => {
    const r = { ok: false as const, code: 'rate_limited' };
    expect(afterResult(state, 'draft', r)).toEqual({ ...state, result: r });
  });

  it('moves to the saved version and clears the draft notice', () => {
    const drafted = { ...state, drafted: true };
    expect(afterResult(drafted, 'save', { ok: true, version: 3 })).toMatchObject({
      version: 3,
      drafted: false,
      document: 'mine',
    });
  });

  it('keeps the version loaded when a save is refused', () => {
    const r = { ok: false as const, code: 'version_conflict' };
    expect(afterResult(state, 'save', r)).toMatchObject({ version: 2, result: r });
  });

  it('shows a preview', () => {
    expect(afterResult(state, 'preview', { ok: true, text: 'Report' }).preview).toBe('Report');
  });
});

describe('the output of a document (M5)', () => {
  const doc = (output: string, body = '') =>
    `---\nname: x\ndescription: y\ntrigger: schedule\noutput: ${output}\n---\n\n${body}`;

  it('reads the output from the settings block only', () => {
    expect(frontmatterOutput(doc('slack'))).toBe('slack');
    expect(frontmatterOutput(doc("'teams'"))).toBe('teams');
    expect(frontmatterOutput(doc('email', 'output: slack'))).toBe('email');
    expect(frontmatterOutput('no settings\noutput: slack')).toBeNull();
    expect(frontmatterOutput('---\nname: x\n---\noutput: slack')).toBeNull();
  });

  it('posts to a channel only for slack and teams', () => {
    expect(postsToChannel(doc('slack'))).toBe(true);
    expect(postsToChannel(doc('teams'))).toBe(true);
    expect(postsToChannel(doc('email'))).toBe(false);
    expect(postsToChannel('broken')).toBe(false);
  });
});
