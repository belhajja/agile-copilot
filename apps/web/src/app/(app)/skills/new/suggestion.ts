import { parseSkillDocument } from '@agile/skills';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { skillSuggestionOf } from '@/components/agent/tool-output';

/**
 * The SKILL.md the assistant proposed with `suggest_skill` call `toolCallId`, parsed again with the
 * skills schema; null for anything else (unknown id, another tool, unfinished, invalid). The caller
 * passes the messages of the user's own conversation (`loadConversation`), never client data.
 */
export function findSkillSuggestion(
  messages: readonly UIMessage[],
  toolCallId: string,
): string | null {
  // Tool call ids are unique within a conversation (the AI SDK generates one when the provider
  // doesn't), so the first match is the suggestion.
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const part of m.parts) {
      if (!isToolUIPart(part) || part.toolCallId !== toolCallId) continue;
      if (getToolName(part) !== 'suggest_skill' || part.state !== 'output-available') return null;
      const document = skillSuggestionOf(part.output)?.document;
      return document && parseSkillDocument(document).ok ? document : null;
    }
  }
  return null;
}
