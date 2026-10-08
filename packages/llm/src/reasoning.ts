import { extractReasoningMiddleware, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';

const isJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/**
 * Tool arguments without the reasoning some models put in front of them (MiniMax M2 behind a
 * gateway, on a forced tool call: `<think>…</think>{"name":…}`). Valid JSON is left alone.
 */
function stripThinking(input: string): string {
  if (isJson(input)) return input;
  const end = input.lastIndexOf('</think>');
  if (end === -1) return input;
  const rest = input.slice(end + '</think>'.length).trim();
  return isJson(rest) ? rest : input;
}

const toolInputWithoutThinking: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.map((part) =>
        part.type === 'tool-call' ? { ...part, input: stripThinking(part.input) } : part,
      ),
    };
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(
              part.type === 'tool-call' ? { ...part, input: stripThinking(part.input) } : part,
            );
          },
        }),
      ),
    };
  },
};

/**
 * Self-hosted reasoning models often return their reasoning inline as `<think>…</think>` (no
 * separate field), in answers and even in tool arguments: kept out of both, as reasoning.
 */
export function withInlineReasoning(model: Parameters<typeof wrapLanguageModel>[0]['model']) {
  return wrapLanguageModel({
    model,
    middleware: [extractReasoningMiddleware({ tagName: 'think' }), toolInputWithoutThinking],
  });
}
