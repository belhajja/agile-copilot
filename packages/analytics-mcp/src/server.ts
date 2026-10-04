import { METRIC_KEYS } from '@agile/dashboards';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type AnalyticsContext, listBoardSummaries, openBoard, UnknownBoardError } from './boards';
import { findIssues, findIssuesInput } from './issues';
import { computeMetric, METRIC_GUIDE, metricCatalog, metricSpec } from './metrics';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const failure = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

/** The only error code a tool reports for an unexpected failure. */
export type AnalyticsErrorCode = 'internal_error';

export interface AnalyticsServerOptions {
  /**
   * Called with any unexpected tool failure (never shown to the model). Callers log the error
   * NAME and the code only: driver messages can hold connection strings or row data.
   */
  onError?: (error: unknown, code: AnalyticsErrorCode) => void;
}

const INTERNAL_ERROR = 'The analytics tool failed (internal_error).';

/**
 * Never rethrows: an unknown board is a fixed sentence the model can act on, anything else is a
 * fixed sentence with a code, so no DB/driver message or stack ever reaches the tool output.
 */
async function guarded(
  options: AnalyticsServerOptions,
  fn: () => Promise<ReturnType<typeof result>>,
) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UnknownBoardError) return failure(e.message);
    try {
      options.onError?.(e, 'internal_error');
    } catch {
      // A failing logger must not turn into a tool error with its own text.
    }
    return failure(INTERNAL_ERROR);
  }
}

const metricEnum = z.enum(METRIC_KEYS as [string, ...string[]]);
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * The analytics MCP server for ONE caller. Tenant and clock are bound here, server-side: no tool
 * takes an organisation or connection id, and board ids are re-checked against the caller's
 * workspace on every call. Read-only; numbers come from the deterministic metrics engine.
 */
export function createAnalyticsMcpServer(
  ctx: AnalyticsContext,
  options: AnalyticsServerOptions = {},
): McpServer {
  const server = new McpServer({ name: 'agile-analytics', version: '1.0.0' });

  server.registerTool(
    'list_boards',
    {
      description: 'List the synced Jira boards of this workspace (ids for the other tools).',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => guarded(options, async () => result({ boards: await listBoardSummaries(ctx) })),
  );

  server.registerTool(
    'list_metrics',
    {
      description: 'List the available metrics with a one-line summary and default parameters.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => guarded(options, async () => result({ metrics: metricCatalog() })),
  );

  server.registerTool(
    'get_metric',
    {
      description:
        'Compute a metric for a board from synced Jira data (deterministic). Optional params override the defaults shown by list_metrics.',
      inputSchema: {
        boardId: z.string().describe('Board id from list_boards'),
        metric: metricEnum,
        params: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: readOnly,
    },
    async ({ boardId, metric, params }) =>
      guarded(options, async () => {
        const spec = metricSpec(metric as (typeof METRIC_KEYS)[number], params);
        if (!spec.ok) return failure(`Invalid params: ${spec.issues.join('; ')}`);
        const { board, dataset } = await openBoard(ctx, boardId);
        return result({
          board: { id: board.id, name: board.name },
          metric,
          params: spec.spec.params,
          data: computeMetric(spec.spec, dataset, ctx.now()),
        });
      }),
  );

  server.registerTool(
    'forecast',
    {
      description:
        'Monte Carlo forecast from recent throughput: how many issues in N days, or when N issues will be done (50/85/95% confidence).',
      inputSchema: {
        boardId: z.string().describe('Board id from list_boards'),
        question: z.enum(['how_many', 'when']),
        days: z.number().int().min(1).max(365).optional().describe('how_many: horizon in days'),
        items: z.number().int().min(1).max(500).optional().describe('when: number of issues'),
        historyDays: z.number().int().min(1).max(365).optional().describe('Throughput history'),
      },
      annotations: readOnly,
    },
    async ({ boardId, question, days, items, historyDays }) =>
      guarded(options, async () => {
        const metric = question === 'how_many' ? 'forecast_how_many' : 'forecast_when';
        const spec = metricSpec(
          metric,
          question === 'how_many' ? { days, historyDays } : { items, historyDays },
        );
        if (!spec.ok) return failure(`Invalid params: ${spec.issues.join('; ')}`);
        const { board, dataset } = await openBoard(ctx, boardId);
        return result({
          board: { id: board.id, name: board.name },
          question,
          params: spec.spec.params,
          data: computeMetric(spec.spec, dataset, ctx.now()),
        });
      }),
  );

  server.registerTool(
    'find_issues',
    {
      description:
        'Find synced issues of a board with simple filters (status category, type, assignee, text, sprint, flagged, stale). No JQL.',
      inputSchema: findIssuesInput,
      annotations: readOnly,
    },
    async (input) =>
      guarded(options, async () => {
        const { board, dataset } = await openBoard(ctx, input.boardId);
        return result({
          board: { id: board.id, name: board.name },
          ...findIssues(dataset, input, ctx.now()),
        });
      }),
  );

  server.registerTool(
    'explain_metric',
    {
      description: 'Explain how a metric is defined and computed.',
      inputSchema: { metric: metricEnum },
      annotations: readOnly,
    },
    async ({ metric }) =>
      guarded(options, async () => {
        const key = metric as (typeof METRIC_KEYS)[number];
        const spec = metricSpec(key, {});
        return result({
          metric,
          ...METRIC_GUIDE[key],
          defaultParams: spec.ok ? spec.spec.params : {},
        });
      }),
  );

  return server;
}
