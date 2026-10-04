import type { EditorResult } from './actions';

/** What the skill editor shows; changed only by the user's typing and by `afterResult`. */
export interface EditorState {
  document: string;
  /** The text came from "Draft with AI" and is not saved yet: the user reviews it first. */
  drafted: boolean;
  preview: string | null;
  /** The version the next save starts from. */
  version: number | undefined;
  result: EditorResult | null;
}

/**
 * The editor after an action: a draft only fills the text (never saved), a preview shows its
 * report, a save moves to the new version. A failure keeps everything and shows its code.
 */
export function afterResult(
  state: EditorState,
  kind: 'draft' | 'preview' | 'save',
  r: EditorResult,
): EditorState {
  const next = { ...state, result: r };
  if (!r.ok) return next;
  if (kind === 'draft' && r.document) return { ...next, document: r.document, drafted: true };
  if (kind === 'preview') return { ...next, preview: r.text ?? '' };
  if (kind === 'save') return { ...next, version: r.version ?? state.version, drafted: false };
  return next;
}

/**
 * The `output:` of a document's settings block (between the first two `---` lines), or null.
 * A light read for the UI only; the server parses and validates the document itself.
 */
export function frontmatterOutput(document: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document)?.[1];
  if (block === undefined) return null;
  const value = /^output:[ \t]*(.*?)[ \t]*$/m.exec(block)?.[1];
  return value ? value.replace(/^(['"])(.*)\1$/, '$2') : null;
}

/** Only the slack and teams outputs post to a channel. */
export const postsToChannel = (document: string) => {
  const output = frontmatterOutput(document);
  return output === 'slack' || output === 'teams';
};
