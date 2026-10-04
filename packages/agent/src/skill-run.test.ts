import { createLlmConnection, setBackgroundLlmConnection } from '@agile/connections';
import { agentUsage } from '@agile/db';
import { type MockMcpAtlassian, startMockMcpAtlassian } from '@agile/jira-tools/testing';
import { agentDemoScript, type MockScript } from '@agile/llm/testing';
import {
  BUILTIN_SKILLS,
  createSkill,
  parseSkillDocument,
  type SkillDocument,
  serializeSkill,
} from '@agile/skills';
import { manager, owner, viewer } from '@agile/sync/testing';
import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftSkill, draftToDocument, runSkill, type SkillRunDeps } from './skill-run';
import { startAgentHarness } from './test-harness';

/** The demo script, plus a "jira-check" skill whose run searches Jira, and a failing skill. */
const script: MockScript = (req) => {
  const ask = String([...req.messages].reverse().find((m) => m.role === 'user')?.content);
  const last = req.messages.at(-1);
  if (/<skill name="jira-check">/.test(ask)) {
    if (last?.role === 'tool') return { text: 'Jira checked.' };
    return req.tools.includes('jira_search')
      ? { toolCalls: [{ name: 'jira_search', args: { jql: 'project = DEMO', limit: 5 } }] }
      : { text: 'No Jira tools.' };
  }
  if (/<skill name="breaks">/.test(ask)) throw new Error('scripted failure');
  // Fails partway: one tool step, then the model errors.
  if (/<skill name="half-way">/.test(ask)) {
    if (last?.role === 'tool') throw new Error('scripted failure after a tool step');
    return { toolCalls: [{ name: 'list_boards', args: {} }] };
  }
  if (req.tools.includes('propose_skill') && /break the builder/i.test(ask)) {
    throw new Error('scripted draft failure');
  }
  if (/<skill name="silent">/.test(ask)) return { text: '   ' };
  return agentDemoScript(req);
};

const skill = (name: string, extra: Record<string, unknown> = {}): SkillDocument => {
  const parsed = parseSkillDocument(
    serializeSkill({
      frontmatter: { name, description: `About ${name}`, ...extra },
      instructions: 'Check the boards.',
    }),
  );
  if (!parsed.ok) throw new Error('bad test skill');
  return parsed.skill;
};
const weekly = { trigger: 'schedule', schedule: { cron: '0 8 * * 1' }, output: 'email' };

describe('skill runs (background, read-only) and the skill builder', () => {
  let h: Awaited<ReturnType<typeof startAgentHarness>>;
  let readonly: MockMcpAtlassian;
  let deps: SkillRunDeps;
  beforeAll(async () => {
    h = await startAgentHarness({ script });
    readonly = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'], readOnly: true });
    deps = { ...h.deps, mcpAtlassianReadonlyUrl: readonly.url };
  });
  afterAll(async () => {
    await readonly?.close();
    await h?.stop();
  });

  const lastRequest = () => h.llm.requests.at(-1);
  /** The run request: the last user message the model received. */
  const runMessage = () =>
    String([...(lastRequest()?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content);
  const lastUsage = async () =>
    (await h.rawDb.select().from(agentUsage).orderBy(desc(agentUsage.createdAt)).limit(1))[0];

  it('runs a skill with read-only tools, the run prompt, and meters it against the run', async () => {
    const health = BUILTIN_SKILLS.find((s) => s.key === 'sprint-health-check');
    if (!health) throw new Error('missing built-in');
    const runId = '7d7c5a3e-1111-4c2d-9e3f-0a1b2c3d4e5f';
    const r = await runSkill(deps, owner(), { skill: health.skill, skillRunId: runId });
    expect(r).toEqual({ ok: true, text: 'Report for sprint-health-check: 2 boards checked.' });
    const sent = lastRequest();
    expect(sent?.tools).toContain('list_boards');
    expect(sent?.tools.filter((t) => t.startsWith('jira_')).sort()).toEqual([
      'jira_get_agile_boards',
      'jira_get_issue',
      'jira_get_sprint_issues',
      'jira_get_sprints_from_board',
      'jira_get_transitions',
      'jira_search',
    ]);
    expect(sent?.tools).not.toContain('pin_widget');
    expect(sent?.tools).not.toContain('load_skill');
    expect(String(sent?.messages[0]?.content)).toMatch(/running a saved skill for its owner/);
    expect(runMessage()).toMatch(/^Run this skill now\.\n<skill name="sprint-health-check">\n/);
    expect(await lastUsage()).toMatchObject({
      conversationId: null,
      skillRunId: runId,
      userId: owner().userId,
      inputTokens: 240,
      outputTokens: 60,
    });
  });

  it('reads live Jira only through the read-only instance, never the read-write one', async () => {
    const before = h.mcp.calls.length;
    expect(await runSkill(deps, owner(), { skill: skill('jira-check') })).toEqual({
      ok: true,
      text: 'Jira checked.',
    });
    expect(readonly.calls.map((c) => c.name)).toEqual(['jira_search']);
    expect(h.mcp.calls.length).toBe(before);
    // Without the read-only instance, Data Center (PAT) sites have no Jira tools in runs.
    expect(
      await runSkill({ ...deps, mcpAtlassianReadonlyUrl: undefined }, owner(), {
        skill: skill('jira-check'),
      }),
    ).toEqual({ ok: true, text: 'No Jira tools.' });
  });

  it("gives a viewer's runs the analytics tools only (live Jira reads need `jira.read`)", async () => {
    expect(await runSkill(deps, viewer(), { skill: skill('jira-check') })).toEqual({
      ok: true,
      text: 'No Jira tools.',
    });
  });

  it("gives a manager's runs live Jira reads, read-only, through the read-only instance", async () => {
    const readonlyBefore = readonly.calls.length;
    const before = h.mcp.calls.length;
    expect(await runSkill(deps, manager(), { skill: skill('jira-check') })).toEqual({
      ok: true,
      text: 'Jira checked.',
    });
    const jiraSent = (lastRequest()?.tools ?? []).filter((t) => t.startsWith('jira_'));
    expect(jiraSent.sort()).toEqual([
      'jira_get_agile_boards',
      'jira_get_issue',
      'jira_get_sprint_issues',
      'jira_get_sprints_from_board',
      'jira_get_transitions',
      'jira_search',
    ]);
    expect(readonly.calls.slice(readonlyBefore).map((c) => c.name)).toEqual(['jira_search']);
    expect(h.mcp.calls.length).toBe(before);
  });

  it("applies the owner's standing preferences and passes alert facts as data", async () => {
    await createSkill(h.db, owner(), {
      document: serializeSkill({
        frontmatter: { name: 'no-names', description: 'Privacy', trigger: 'always' },
        instructions: 'Never name individuals.',
      }),
      now: new Date(),
    });
    const r = await runSkill(deps, owner(), {
      skill: skill('wip-watch'),
      context: { boards: [{ name: 'DEMO Kanban', value: 12 }] },
    });
    expect(r).toEqual({
      ok: true,
      text: 'Report for wip-watch: 2 boards checked. (preferences: no-names)',
    });
    const run = runMessage();
    expect(run).toContain('<data source="skill_trigger">');
    expect(run).toContain('"value":12');
  });

  it('uses the background model for scheduled skills and the default one otherwise', async () => {
    const cheap = await createLlmConnection(h.deps, owner(), {
      label: 'Cheap',
      config: {
        provider: 'openai_compatible',
        model: 'mock-cheap',
        baseUrl: h.llm.baseUrl,
        apiKey: 'good-key',
      },
    });
    if (!cheap.ok) throw new Error(cheap.code);
    await setBackgroundLlmConnection(h.deps, owner(), cheap.connection.id);
    await runSkill(deps, owner(), { skill: skill('weekly-report', weekly) });
    expect((await lastUsage())?.model).toBe('mock-cheap');
    await runSkill(deps, owner(), { skill: skill('ad-hoc') });
    expect((await lastUsage())?.model).toBe('mock');
    await setBackgroundLlmConnection(h.deps, owner(), null);
  });

  it('reports failures with codes', async () => {
    expect(await runSkill(deps, owner(), { skill: skill('breaks') })).toEqual({
      ok: false,
      code: 'model_failed',
    });
    expect(await runSkill(deps, owner(), { skill: skill('silent') })).toEqual({
      ok: false,
      code: 'empty_output',
    });
    expect(await runSkill(deps, owner('org_b'), { skill: skill('x') })).toEqual({
      ok: false,
      code: 'no_llm',
    });
  });

  it('never retries a failed model call: a failing run or draft makes exactly one request', async () => {
    const before = h.llm.requests.length;
    expect(await runSkill(deps, owner(), { skill: skill('breaks') })).toEqual({
      ok: false,
      code: 'model_failed',
    });
    expect(h.llm.requests.length - before).toBe(1);
    const draftBefore = h.llm.requests.length;
    expect(await draftSkill(deps, owner(), 'Please break the builder')).toEqual({
      ok: false,
      code: 'model_failed',
    });
    expect(h.llm.requests.length - draftBefore).toBe(1);
  });

  it('meters a run that fails after a tool step against the run', async () => {
    const runId = '7d7c5a3e-2222-4c2d-9e3f-0a1b2c3d4e5f';
    expect(await runSkill(deps, owner(), { skill: skill('half-way'), skillRunId: runId })).toEqual({
      ok: false,
      code: 'model_failed',
    });
    expect(await lastUsage()).toMatchObject({
      conversationId: null,
      skillRunId: runId,
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it('refuses an actor without any role (an owner who left), before any model call', async () => {
    const before = h.llm.requests.length;
    const usageBefore = (await h.rawDb.select().from(agentUsage)).length;
    expect(await runSkill(deps, { ...owner(), roles: [] }, { skill: skill('x') })).toEqual({
      ok: false,
      code: 'forbidden_role',
    });
    expect(h.llm.requests.length).toBe(before);
    expect((await h.rawDb.select().from(agentUsage)).length).toBe(usageBefore);
  });

  it('meters a draft only once its model call was made', async () => {
    const usageBefore = (await h.rawDb.select().from(agentUsage)).length;
    expect(await draftSkill(deps, owner('org_b'), 'Anything')).toEqual({
      ok: false,
      code: 'no_llm',
    });
    expect((await h.rawDb.select().from(agentUsage)).length).toBe(usageBefore);
  });

  it("drafts a skill from the user's words, as a valid SKILL.md", async () => {
    const r = await draftSkill(
      deps,
      owner(),
      'Every Monday tell me which stories are at risk for the sprint goal',
    );
    if (!r.ok) throw new Error(r.code);
    const parsed = parseSkillDocument(r.document);
    expect(parsed.ok && parsed.skill.frontmatter).toEqual({
      name: 'monday-risks',
      description: 'Stories at risk for the sprint goal, every Monday',
      trigger: 'schedule',
      schedule: { cron: '0 8 * * 1', timezone: 'UTC' },
      output: 'email',
    });
    expect(lastRequest()?.tools).toEqual(['propose_skill']);
    expect(await lastUsage()).toMatchObject({ conversationId: null, skillRunId: null });
  });

  it('turns an invalid proposal into an on-demand chat skill rather than failing', () => {
    const logged: [string, string][] = [];
    const document = draftToDocument(
      {
        name: 'Too Often!',
        description: 'Checks\nconstantly',
        trigger: 'schedule',
        cron: '*/5 * * * *',
        output: 'slack',
        instructions: 'Check.',
      },
      (e, code) => logged.push([(e as Error).name, code]),
    );
    // The fallback is visible in the logs (by code and error name).
    expect(logged).toEqual([['ZodError', 'skill_draft_fallback']]);
    const parsed = parseSkillDocument(document ?? '');
    expect(parsed.ok && parsed.skill.frontmatter).toEqual({
      name: 'too-often',
      description: 'Checks constantly',
      trigger: 'on_demand',
      output: 'chat',
    });
  });
});
