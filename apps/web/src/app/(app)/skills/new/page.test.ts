import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CONVERSATION = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const ACTOR = { orgId: 'org', userId: 'user', roles: ['viewer'] as string[] };

const agent = vi.hoisted(() => ({ loadConversation: vi.fn() }));
const suggestion = vi.hoisted(() => ({ findSkillSuggestion: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@agile/agent', () => agent);
vi.mock('@agile/auth', () => ({ canManageConnections: () => false }));
vi.mock('@agile/notify', () => ({ listDeliveryChannels: async () => [] }));
vi.mock('@agile/skills', () => ({ serializeSkill: () => 'TEMPLATE' }));
vi.mock('../skill-editor', () => ({ SkillEditor: () => null }));
vi.mock('./suggestion', () => suggestion);
vi.mock('@/server/context', () => ({
  requireActor: async () => ACTOR,
  services: () => ({ db: {} }),
}));

const { default: NewSkillPage } = await import('./page');

const kids = (n: ReactNode): ReactNode[] => {
  if (Array.isArray(n)) return n.flatMap(kids);
  return n === null || n === undefined || typeof n === 'boolean' ? [] : [n];
};
const find = (n: ReactNode, test: (e: ReactElement<Record<string, unknown>>) => boolean) => {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (x: ReactNode) => {
    for (const c of kids(x)) {
      if (!isValidElement<Record<string, unknown>>(c)) continue;
      if (test(c)) out.push(c);
      walk(c.props.children as ReactNode);
    }
  };
  walk(n);
  return out;
};
const has = (attr: string) => (e: ReactElement<Record<string, unknown>>) => attr in e.props;
const editorDocument = (tree: ReactNode) =>
  find(tree, has('initialDocument'))[0]?.props.initialDocument;
const notice = (tree: ReactNode) => find(tree, has('data-suggestion'))[0]?.props['data-suggestion'];

const render = (searchParams: Record<string, unknown> = {}) =>
  NewSkillPage({ searchParams: Promise.resolve(searchParams) });

describe('the new skill page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts from the template without a suggestion', async () => {
    const tree = await render();
    expect(editorDocument(tree)).toBe('TEMPLATE');
    expect(notice(tree)).toBeUndefined();
    expect(agent.loadConversation).not.toHaveBeenCalled();
  });

  it('pre-fills the editor from a suggestion in the user’s own conversation', async () => {
    const messages = [{ id: 'a1', role: 'assistant', parts: [] }];
    agent.loadConversation.mockResolvedValue({ id: CONVERSATION, title: 't', messages });
    suggestion.findSkillSuggestion.mockReturnValue('SUGGESTED');
    const tree = await render({ from: CONVERSATION, suggestion: 'call-1' });
    expect(agent.loadConversation).toHaveBeenCalledWith({}, ACTOR, CONVERSATION);
    expect(suggestion.findSkillSuggestion).toHaveBeenCalledWith(messages, 'call-1');
    expect(editorDocument(tree)).toBe('SUGGESTED');
    expect(notice(tree)).toBe('loaded');
  });

  it('falls back to the template when the conversation is not the user’s', async () => {
    agent.loadConversation.mockResolvedValue(null);
    const tree = await render({ from: CONVERSATION, suggestion: 'call-1' });
    expect(editorDocument(tree)).toBe('TEMPLATE');
    expect(notice(tree)).toBe('missing');
    expect(suggestion.findSkillSuggestion).not.toHaveBeenCalled();
  });

  it('falls back to the template when the suggestion is not found', async () => {
    agent.loadConversation.mockResolvedValue({ id: CONVERSATION, title: 't', messages: [] });
    suggestion.findSkillSuggestion.mockReturnValue(null);
    const tree = await render({ from: CONVERSATION, suggestion: 'call-1' });
    expect(editorDocument(tree)).toBe('TEMPLATE');
    expect(notice(tree)).toBe('missing');
  });

  it('treats a half or repeated query as not found, without loading anything', async () => {
    const half = await render({ from: CONVERSATION });
    expect(notice(half)).toBe('missing');
    const repeated = await render({ from: [CONVERSATION, CONVERSATION], suggestion: 'call-1' });
    expect(notice(repeated)).toBe('missing');
    expect(agent.loadConversation).not.toHaveBeenCalled();
  });
});
