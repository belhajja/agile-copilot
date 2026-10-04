import { demoDataset, type MockJira, startMockJira } from '@agile/jira/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GenericContainer, type StartedTestContainer, TestContainers, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JIRA_TOOL_NAMES, JIRA_TOOLS, type JiraToolName, parseJiraToolInput } from './catalog';
import { MCP_ATLASSIAN_IMAGE } from './image';
import {
  codeFromToolText,
  createMcpAtlassianBackend,
  MCP_ATLASSIAN_ENABLED_TOOLS,
  type McpCredentials,
  mcpAtlassianHeaders,
} from './mcp-backend';
import { createRestJiraBackend } from './rest-backend';
import {
  ANCHOR,
  EXPECTED_WRITES,
  exercise,
  outbound,
  SCENARIO_COMMENT,
  SCENARIO_DESCRIPTION,
} from './testing/scenario';
import { generatedMarkdown, pathologicalMarkdown, WIKI_CASES } from './testing/wiki-cases';
import { markdownToJiraWiki } from './wiki';

// The mock Jira runs in this process; the containers reach it through Testcontainers' SSH port
// forwarder under a hostname (mcp-atlassian refuses IP-literal Jira URLs even when allowlisted).
// The forwarder works the same against a remote daemon (GitLab's docker:dind service).
const HOST_ALIAS = 'host.testcontainers.internal';
const READ_TOOLS = JIRA_TOOL_NAMES.filter((n) => !JIRA_TOOLS[n].write);

const start = (env: Record<string, string>) =>
  new GenericContainer(MCP_ATLASSIAN_IMAGE)
    .withEnvironment({
      TRANSPORT: 'streamable-http',
      PORT: '8000',
      TOOLSETS: 'all',
      // The mock Jira is reached through Testcontainers' host alias, a private address.
      MCP_ALLOWED_URL_DOMAINS: HOST_ALIAS,
      // Same settings as the compose files: the shared instance also serves Cloud OAuth tokens.
      ATLASSIAN_OAUTH_ENABLE: 'true',
      ...env,
    })
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forHttp('/healthz', 8000))
    .withStartupTimeout(120_000)
    .start();

const SAMPLES: { [N in JiraToolName]: unknown } = {
  jira_search: { jql: 'filter = 101', limit: 3 },
  jira_get_issue: { issueKey: 'DEMO-1' },
  jira_get_transitions: { issueKey: 'DEMO-1' },
  jira_get_agile_boards: { projectKey: 'DEMO' },
  jira_get_sprints_from_board: { boardId: '1', state: 'active' },
  jira_get_sprint_issues: { sprintId: '4' },
  jira_add_comment: { issueKey: 'DEMO-1', body: 'Blocked by the API team' },
  jira_transition_issue: { issueKey: 'DEMO-2', transitionId: '21', comment: 'Started' },
  jira_assign_issue: { issueKey: 'DEMO-2', assignee: 'alex' },
  jira_create_issue: { projectKey: 'DEMO', summary: 'Follow up', issueType: 'Task' },
  jira_update_issue: {
    issueKey: 'DEMO-3',
    summary: 'Renamed',
    description: 'Needs a *review*',
    labels: ['risk'],
  },
};

const mockJira = () =>
  startMockJira({
    flavor: 'datacenter',
    validAuthorization: 'Bearer good-pat',
    dataset: demoDataset(ANCHOR),
    // A fixed clock: two mocks given the same writes end in the same state.
    now: () => ANCHOR,
  });
const portOf = (m: MockJira) => Number(new URL(m.url).port);

describe(`contract: ${MCP_ATLASSIAN_IMAGE}`, () => {
  /** Reached by the containers (brief's checks, error texts). */
  let jira: MockJira;
  /** A fresh Jira for the shared scenario through the image, and its twin for the REST backend. */
  let viaImage: MockJira;
  let viaRest: MockJira;
  let shared: StartedTestContainer;
  let readOnly: StartedTestContainer;
  const mcpUrl = (c: StartedTestContainer) => `http://${c.getHost()}:${c.getMappedPort(8000)}/mcp`;
  const aliasUrl = (m: MockJira) => `http://${HOST_ALIAS}:${portOf(m)}`;
  const dcCreds = (m: MockJira, token = 'good-pat'): McpCredentials => ({
    kind: 'datacenter_pat',
    baseUrl: aliasUrl(m),
    token,
  });

  async function withClient<T>(
    url: string,
    headers: Record<string, string>,
    fn: (c: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: 'contract', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
    );
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  const listTools = (url: string, headers: Record<string, string>) =>
    withClient(url, headers, async (c) => (await c.listTools()).tools);
  /** One raw tool call: mcp-atlassian's own text, as the backend reads it. */
  const rawCall = (creds: McpCredentials, name: string, args: Record<string, unknown>) =>
    withClient(mcpUrl(shared), mcpAtlassianHeaders(creds), async (c) => {
      const r = await c.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[])
        .map((x) => x.text ?? '')
        .join('\n');
      return { isError: r.isError === true, text };
    });

  beforeAll(async () => {
    await Promise.all([
      mockJira().then((m) => {
        jira = m;
      }),
      mockJira().then((m) => {
        viaImage = m;
      }),
      mockJira().then((m) => {
        viaRest = m;
      }),
    ]);
    await TestContainers.exposeHostPorts(portOf(jira), portOf(viaImage));
    // Each container is kept as soon as it runs, and both starts are awaited: if one fails,
    // afterAll still stops the other.
    const started = await Promise.allSettled([
      // The read-write instance also enables the backend-only assignee lookup.
      start({ ENABLED_TOOLS: MCP_ATLASSIAN_ENABLED_TOOLS.join(',') }).then((c) => {
        shared = c;
      }),
      // The read-only twin: the catalog, with READ_ONLY_MODE removing every write.
      start({ ENABLED_TOOLS: JIRA_TOOL_NAMES.join(','), READ_ONLY_MODE: 'true' }).then((c) => {
        readOnly = c;
      }),
    ]);
    for (const r of started) if (r.status === 'rejected') throw r.reason;
  });
  afterAll(async () => {
    await Promise.all([
      shared?.stop(),
      readOnly?.stop(),
      jira?.close(),
      viaImage?.close(),
      viaRest?.close(),
    ]);
  });

  it('serves exactly the enabled tools, and our arguments match their schemas', async () => {
    const tools = await listTools(mcpUrl(shared), mcpAtlassianHeaders(dcCreds(jira)));
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_ATLASSIAN_ENABLED_TOOLS].sort());
    const schema = (name: string) => {
      const tool = tools.find((t) => t.name === name);
      return {
        properties: Object.keys(tool?.inputSchema.properties ?? {}),
        required: tool?.inputSchema.required ?? [],
      };
    };
    const check = (name: string, args: Record<string, unknown>) => {
      const { properties, required } = schema(name);
      expect({ name, unknown: Object.keys(args).filter((k) => !properties.includes(k)) }).toEqual({
        name,
        unknown: [],
      });
      expect({ name, missing: required.filter((k) => !(k in args)) }).toEqual({
        name,
        missing: [],
      });
    };
    for (const name of JIRA_TOOL_NAMES) {
      const parsed = parseJiraToolInput(name, SAMPLES[name]);
      if (!parsed.success) throw new Error(`sample for ${name} is invalid`);
      check(name, (JIRA_TOOLS[name].toMcp as (i: unknown) => Record<string, unknown>)(parsed.data));
    }
    // What createMcpAtlassianBackend sends for an assignment (lookup, then assign by id).
    check('jira_search_assignable_users', { query: 'Alex Martin', issue_key: 'DEMO-2', limit: 50 });
    check('jira_assign_issue', { issue_key: 'DEMO-2', assignee: '{"name":"alex"}' });
  });

  it('the read-only instance (background runs) has no write tools', async () => {
    const tools = await listTools(mcpUrl(readOnly), mcpAtlassianHeaders(dcCreds(jira)));
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it('accepts per-request Cloud OAuth credentials (bearer token + cloud id)', async () => {
    // Only the MCP handshake: a real Cloud call needs a Cloud tenant (README manual checklist).
    const tools = await listTools(
      mcpUrl(shared),
      mcpAtlassianHeaders({
        kind: 'cloud_oauth',
        baseUrl: 'https://acme.atlassian.net',
        cloudId: 'cloud-123',
        accessToken: 'oauth-access-token',
      }),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_ATLASSIAN_ENABLED_TOOLS].sort());
  });

  it('rejects requests without credentials (no fallback to operator credentials)', async () => {
    await expect(listTools(mcpUrl(shared), {})).rejects.toThrow(/401|Authentication required/);
  });

  it('rejects a Jira URL outside MCP_ALLOWED_URL_DOMAINS', async () => {
    const backend = createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: 'http://10.1.2.3:8080', token: 'good-pat' },
      { url: mcpUrl(shared) },
    );
    await expect(
      backend.call('jira_get_issue', { issueKey: 'DEMO-1', commentLimit: 5 }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('runs the shared scenario like the REST backend, with the exact writes and the PAT', async () => {
    const image = await exercise(
      createMcpAtlassianBackend(dcCreds(viaImage), { url: mcpUrl(shared) }),
      viaImage,
    );
    const rest = await exercise(
      createRestJiraBackend(
        { kind: 'datacenter_pat', baseUrl: viaRest.url, token: 'good-pat' },
        { outbound },
      ),
      viaRest,
    );
    expect(image.writes).toEqual(EXPECTED_WRITES);
    expect(rest.writes).toEqual(EXPECTED_WRITES);
    // Normalised results: the same search shape and the same resolved assignee.
    expect(image.found).toEqual(rest.found);
    expect(image.assigned).toEqual(rest.assigned);
    expect(image.assigned).toEqual({
      ok: true,
      issueKey: 'DEMO-2',
      assignee: { id: 'alex', displayName: 'Alex Martin' },
    });
    expect(image.issue.summary).toBe(rest.issue.summary);
    // mcp-atlassian 0.23.1 gives no target status for a transition: only `to` differs.
    expect(image.transitions).toEqual({
      transitions: rest.transitions.transitions.map((t) => ({ ...t, to: null })),
    });
    // IDENTICAL request bodies (P3-R19): the model's Markdown comment and description arrive as
    // the same Jira wiki markup; labels arrive too (mcp-atlassian drops fields Jira does not list).
    expect(viaImage.writes.map((w) => w.body)).toEqual(viaRest.writes.map((w) => w.body));
    expect(viaRest.writes[0]?.body).toEqual({ body: markdownToJiraWiki(SCENARIO_COMMENT) });
    expect(viaRest.writes[0]?.body).toEqual({
      body: 'Blocked by the *API* team:\n* {{npm ci}} fails',
    });
    expect(viaRest.writes.at(-1)?.body).toEqual({
      fields: { labels: ['risk'], description: '*Risk:* the API team is late' },
    });
    // Both Jiras end in the same state where the agent can see it.
    for (const key of ['DEMO-1', 'DEMO-2', 'DEMO-3']) {
      const read = async (m: MockJira) =>
        (await fetch(`${m.url}/rest/api/2/issue/${key}`, {
          headers: { authorization: 'Bearer good-pat' },
        }).then((r) => r.json())) as { fields: Record<string, unknown> };
      const [a, b] = await Promise.all([read(viaImage), read(viaRest)]);
      for (const f of ['status', 'assignee', 'labels', 'summary', 'updated']) {
        expect({ key, f, v: a.fields[f] }).toEqual({ key, f, v: b.fields[f] });
      }
      expect(a.fields.comment).toMatchObject({
        total: (b.fields.comment as { total: number }).total,
      });
    }

    // The assignment: exact lookup through jira_search_assignable_users (DC sends `username=`),
    // then a JSON-object assignee, which mcp-atlassian assigns as is: no lookup of its own.
    const assignable = viaImage.requests.filter((r) =>
      r.path.endsWith('/rest/api/2/user/assignable/search'),
    );
    expect(assignable).toHaveLength(1);
    const params = new URLSearchParams(assignable[0]?.search);
    expect({
      username: params.get('username'),
      query: params.get('query'),
      issueKey: params.get('issueKey'),
      maxResults: params.get('maxResults'),
    }).toEqual({ username: 'Alex Martin', query: null, issueKey: 'DEMO-2', maxResults: '50' });
    expect(
      viaImage.requests.filter((r) => /\/user(\/permission)?\/search$|\/user$/.test(r.path)),
    ).toEqual([]);
    expect(viaImage.writes.find((w) => w.path.endsWith('/assignee'))?.body).toEqual({
      name: 'alex',
    });

    // The caller's PAT reaches Jira on every request (no operator credentials, no anonymous call).
    expect(viaImage.requests.length).toBeGreaterThan(EXPECTED_WRITES.length);
    expect(new Set(viaImage.requests.map((r) => r.authorization))).toEqual(
      new Set(['Bearer good-pat']),
    );
  });

  it('converts Markdown exactly like the image’s own converter (REST backend parity)', async () => {
    // mcp-atlassian's JiraPreprocessor.markdown_to_jira, run inside the running image, in one
    // exec: the fixed cases, the scenario texts, 300 seeded strings over the markup alphabet and
    // 2k-character versions of the inputs that were quadratic. The data goes in on stdin.
    const corpus = [
      ...WIKI_CASES.map(([md]) => md),
      SCENARIO_COMMENT,
      SCENARIO_DESCRIPTION,
      ...generatedMarkdown(300),
      ...Object.values(pathologicalMarkdown(2_000)),
    ];
    const script = [
      'import json, sys',
      'from mcp_atlassian.preprocessing.jira import JiraPreprocessor',
      'p = JiraPreprocessor(base_url="")',
      'print(json.dumps([p.markdown_to_jira(c) for c in json.load(sys.stdin)]))',
    ].join('\n');
    await shared.copyContentToContainer([
      { content: JSON.stringify(corpus), target: '/tmp/md-corpus.json', mode: 0o644 },
    ]);
    const r = await shared.exec(['sh', '-c', 'python -c "$0" < /tmp/md-corpus.json', script]);
    expect({ exitCode: r.exitCode, stderr: r.stderr }).toEqual({ exitCode: 0, stderr: '' });
    const theirs = JSON.parse(r.stdout) as string[];
    expect(theirs).toHaveLength(corpus.length);
    const differences = corpus.flatMap((md, i) => {
      const ours = markdownToJiraWiki(md);
      return ours === theirs[i] ? [] : [{ md, theirs: theirs[i], ours }];
    });
    expect(differences).toEqual([]);
  }, 120_000);

  it('pins the raw search result: a count, and unassigned issues without an id', async () => {
    const { isError, text } = await rawCall(dcCreds(jira), 'jira_search', {
      jql: 'filter = 101',
      limit: 50,
    });
    expect(isError).toBe(false);
    const raw = JSON.parse(text) as {
      total: unknown;
      start_at: unknown;
      issues: { key: string; assignee?: Record<string, unknown> }[];
    };
    expect(raw).toMatchObject({ total: expect.any(Number), start_at: 0 });
    expect(raw.total).toBeGreaterThan(3);
    const unassigned = raw.issues.filter(
      (i) => !i.assignee || !['account_id', 'name', 'key'].some((k) => k in (i.assignee ?? {})),
    );
    expect(unassigned.length).toBeGreaterThan(0);
    // What searchFromMcp turns into `assignee: null`.
    for (const i of unassigned) expect(i.assignee).toEqual({ display_name: 'Unassigned' });
  });

  it('reports a wrong PAT and an unreachable Jira with texts our codes recognise', async () => {
    const wrongPat = await rawCall(dcCreds(jira, 'bad-pat'), 'jira_get_issue', {
      issue_key: 'DEMO-1',
    });
    expect(wrongPat.isError).toBe(true);
    expect(codeFromToolText(wrongPat.text)).toBe('unauthorized');
    // Port 1 on the allowlisted host: nothing listens there.
    const down: McpCredentials = {
      kind: 'datacenter_pat',
      baseUrl: `http://${HOST_ALIAS}:1`,
      token: 'good-pat',
    };
    const unreachable = await rawCall(down, 'jira_get_issue', { issue_key: 'DEMO-1' });
    expect(unreachable.isError).toBe(true);
    expect(codeFromToolText(unreachable.text)).toBe('unavailable');

    // The same through the backend, for a read and for the assignment lookup.
    for (const [creds, code] of [
      [dcCreds(jira, 'bad-pat'), 'unauthorized'],
      [down, 'unavailable'],
    ] as const) {
      const backend = createMcpAtlassianBackend(creds, { url: mcpUrl(shared) });
      await expect(
        backend.call('jira_get_issue', { issueKey: 'DEMO-1', commentLimit: 5 }),
      ).rejects.toMatchObject({ code });
      await expect(
        backend.call('jira_assign_issue', { issueKey: 'DEMO-2', assignee: 'alex' }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('runs every allowlisted tool against Jira with the caller’s PAT', async () => {
    const backend = createMcpAtlassianBackend(dcCreds(jira), { url: mcpUrl(shared) });
    jira.writes.length = 0;
    jira.requests.length = 0;
    for (const name of JIRA_TOOL_NAMES) {
      const parsed = parseJiraToolInput(name, SAMPLES[name]);
      if (!parsed.success) throw new Error(`sample for ${name} is invalid`);
      const outcome = await backend.call(name, parsed.data as never).then(
        () => 'ok',
        (e: unknown) => (e as { code?: string }).code ?? 'error',
      );
      expect({ name, outcome }).toEqual({ name, outcome: 'ok' });
    }
    expect(jira.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /rest/api/2/issue/DEMO-1/comment',
      'POST /rest/api/2/issue/DEMO-2/transitions',
      'PUT /rest/api/2/issue/DEMO-2/assignee',
      'POST /rest/api/2/issue',
      'PUT /rest/api/2/issue/DEMO-3',
    ]);
    // Markdown emphasis becomes wiki markup on the way, as markdownToJiraWiki does for REST.
    expect(jira.writes.at(-1)?.body).toEqual({
      fields: { summary: 'Renamed', labels: ['risk'], description: 'Needs a _review_' },
    });
    expect(jira.writes.every((w) => w.authorization === 'Bearer good-pat')).toBe(true);
    expect(new Set(jira.requests.map((r) => r.authorization))).toEqual(
      new Set(['Bearer good-pat']),
    );
  });
});
