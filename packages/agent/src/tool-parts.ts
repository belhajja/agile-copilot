import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import {
  type DynamicToolUIPart,
  getToolName,
  isStaticToolUIPart,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';

export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** The tool parts of the assistant's messages, in order (the stored objects, not copies). */
export function assistantToolParts(messages: UIMessage[]): ToolPart[] {
  return messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter(isToolUIPart) : []));
}

/**
 * The Jira write parts of the assistant's messages that `keep` selects, in order. Jira writes are
 * static tools: a dynamic part never is one, whatever its name.
 */
export function jiraWriteParts(
  messages: UIMessage[],
  keep: (part: ToolUIPart) => boolean,
): ToolUIPart[] {
  return assistantToolParts(messages).filter(
    (p): p is ToolUIPart => isStaticToolUIPart(p) && isJiraWriteTool(getToolName(p)) && keep(p),
  );
}
