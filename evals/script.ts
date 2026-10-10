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
  const wantsTime = /time did each person log|time logged/i.test(ask);
  const wantsMatrix = /day-by-day/i.test(ask);
  const french = /vélocité|quels|quelle|combien/i.test(ask);
  const wantsMetric = /v[ée]locit|<skill name=/i.test(ask);
  const stale = /stale|old issues/i.test(ask);
  const wantsSprintDates = /dates of the last closed sprint/i.test(ask);
  if (last?.role === 'tool') {
    const name = toolOf(messages, last.tool_call_id);
    if (name === 'jira_worklog_summary') {
      const total = (payload(last) as { totalHours?: number })?.totalHours;
      // A heavy request: the overview now, the matrix on request.
      if (wantsMatrix) {
        return {
          text: `Overview: ${total} hours were logged on DEMO. Want the day-by-day detail?`,
          toolCalls: [
            {
              name: 'suggest_followups',
              args: {
                suggestions: [
                  'Show the day-by-day detail for the first week',
                  'Show the detail for the person who logged the most',
                ],
              },
            },
          ],
        };
      }
      return { text: `${total} hours were logged on DEMO.` };
    }
    if (name === 'suggest_skill') {
      return {
        text: 'I drafted the skill weekly-velocity: open it in the skill builder to review and save it.',
      };
    }
    if (name === 'list_boards' && (wantsMetric || stale || wantsSprintDates)) {
      const boards = (payload(last) as { boards?: { id: string; name: string }[] })?.boards ?? [];
      const board = boards.find((b) => b.name === 'DEMO Scrum') ?? boards[0];
      if (!board) return { text: french ? 'Aucun tableau.' : 'No board.' };
      if (wantsSprintDates) {
        return {
          toolCalls: [
            { name: 'list_sprints', args: { boardId: board.id, state: 'closed', limit: 1 } },
          ],
        };
      }
      return stale
        ? { toolCalls: [{ name: 'find_issues', args: { boardId: board.id, staleDays: 1 } }] }
        : {
            toolCalls: [
              { name: 'get_metric', args: { boardId: board.id, metric: 'average_velocity' } },
            ],
          };
    }
    if (name === 'list_sprints') {
      const sprints =
        (payload(last) as { sprints?: { name: string; startAt: string; endAt: string }[] })
          ?.sprints ?? [];
      const sprint = sprints[0];
      if (!sprint) return { text: 'No closed sprint found.' };
      return {
        text: `The last closed sprint of DEMO Scrum, ${sprint.name}, ran from ${sprint.startAt} to ${sprint.endAt}.`,
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
  if ((wantsTime || wantsMatrix) && tools.includes('jira_worklog_summary')) {
    return { toolCalls: [{ name: 'jira_worklog_summary', args: { jql: 'filter = 101' } }] };
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
  if ((wantsMetric || stale || wantsSprintDates) && tools.includes('list_boards')) {
    return { toolCalls: [{ name: 'list_boards', args: {} }] };
  }
  return agentDemoScript(req);
};
