import { agentDemoScript, type MockChatMessage, type MockScript } from '@agile/llm/testing';

const textOf = (m: MockChatMessage | undefined) =>
  typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((c) => c.text ?? '').join('');

/** The JSON inside a `<data source="…">` envelope. */
const payload = (m: MockChatMessage | undefined): unknown => {
  const inner = /<data source="[^"]*">\n([\s\S]*)\n<\/data>/.exec(textOf(m))?.[1];
  try {
    return JSON.parse(inner ?? 'null');
  } catch {
    return null;
  }
};

const toolOf = (messages: MockChatMessage[], id: string | undefined) => {
  for (const m of [...messages].reverse()) {
    const call = m.tool_calls?.find((c) => c.id === id);
    if (call) return call.function.name;
  }
  return undefined;
};

/**
 * The deterministic "model" of the mock eval job: it uses the tools the way a good model should
 * (boards first, then the engine's numbers), answers in the question's language, and reports the
 * numbers it received. It checks the plumbing (tools offered, envelopes, numbers flowing back,
 * approvals, the skill suggestion), not model quality: the live job measures that.
 */
export const evalScript: MockScript = (req) => {
  const { messages, tools } = req;
  const ask = textOf([...messages].reverse().find((m) => m.role === 'user'));
  const last = messages.at(-1);
  const wantsSkill = /as a skill/i.test(ask);
  const french = /vélocité|quels|quelle|combien/i.test(ask);
  const wantsMetric = /v[ée]locit|<skill name=/i.test(ask);
  const stale = /stale|old issues/i.test(ask);
  if (last?.role === 'tool') {
    const name = toolOf(messages, last.tool_call_id);
    if (name === 'suggest_skill') {
      return {
        text: 'I drafted the skill weekly-velocity: open it in the skill builder to review and save it.',
      };
    }
    if (name === 'list_boards' && (wantsMetric || stale)) {
      const boards = (payload(last) as { boards?: { id: string; name: string }[] })?.boards ?? [];
      const board = boards.find((b) => b.name === 'DEMO Scrum') ?? boards[0];
      if (!board) return { text: french ? 'Aucun tableau.' : 'No board.' };
      return stale
        ? { toolCalls: [{ name: 'find_issues', args: { boardId: board.id, staleDays: 1 } }] }
        : {
            toolCalls: [
              { name: 'get_metric', args: { boardId: board.id, metric: 'average_velocity' } },
            ],
          };
    }
    if (name === 'get_metric') {
      const value = (payload(last) as { data?: { value?: number } })?.data?.value;
      return {
        text: french
          ? `La vélocité moyenne de DEMO Scrum est de ${value} points par sprint.`
          : `The average velocity of DEMO Scrum is ${value} points per sprint.`,
      };
    }
    if (name === 'find_issues') {
      const issues = (payload(last) as { issues?: { key: string }[] })?.issues ?? [];
      return { text: `I found ${issues.length} issues: ${issues.map((i) => i.key).join(', ')}.` };
    }
    return agentDemoScript(req);
  }
  if (wantsSkill && tools.includes('suggest_skill')) {
    return {
      toolCalls: [
        {
          name: 'suggest_skill',
          args: {
            name: 'weekly-velocity',
            description: 'Average velocity of the Scrum boards, every Monday',
            trigger: 'schedule',
            cron: '0 8 * * 1',
            timezone: 'Europe/Paris',
            output: 'email',
            instructions:
              '1. Call list_boards.\n2. For each Scrum board, call get_metric with average_velocity.\n3. Show a table of boards and velocities.',
          },
        },
      ],
    };
  }
  if ((wantsMetric || stale) && tools.includes('list_boards')) {
    return { toolCalls: [{ name: 'list_boards', args: {} }] };
  }
  return agentDemoScript(req);
};
