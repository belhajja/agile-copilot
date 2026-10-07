import {
  boardQuerySchema,
  CATALOG_METRIC_KEYS,
  type CatalogMetricKey,
  runQuery,
} from '@agile/dashboards';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type AnalyticsContext, listBoardSummaries, openBoard, UnknownBoardError } from './boards';
import { findIssues, findIssuesInput } from './issues';
import { capRows, computeMetric, METRIC_GUIDE, metricCatalog, metricSpec } from './metrics';
import { QUERY_GUIDE } from './query';
import { listSprints } from './sprints';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
/** What a failed tool reports: a fixed `error` sentence (the model may act on it) and its `code`. */
export type AnalyticsFailureCode =
  | 'internal_error'
  | 'unknown_board'
  | 'invalid_params'
  | 'invalid_query';

const failure = (code: AnalyticsFailureCode, message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }) }],
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
    if (e instanceof UnknownBoardError) return failure('unknown_board', e.message);
    try {
      options.onError?.(e, 'internal_error');
    } catch {
      // A failing logger must not turn into a tool error with its own text.
    }
    return failure('internal_error', INTERNAL_ERROR);
  }
}

const metricEnum = z.enum(CATALOG_METRIC_KEYS as [string, ...string[]]);
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
        params: z
          .record(z.string(), z.unknown())
          .refine((p) => Object.keys(p).length <= 10, 'at most 10 params')
          .optional()
          .describe('Metric parameters (see list_metrics); at most 10 keys'),
      },
      annotations: readOnly,
    },
    async ({ boardId, metric, params }) =>
      guarded(options, async () => {
        const spec = metricSpec(metric as CatalogMetricKey, params);
        if (!spec.ok) return failure('invalid_params', `Invalid params: ${spec.issues.join('; ')}`);
        const { board, dataset } = await openBoard(ctx, boardId);
        const now = ctx.now();
        return result({
          board: { id: board.id, name: board.name },
          metric,
          params: spec.spec.params,
          data: computeMetric(spec.spec, dataset, now),
          chart: spec.spec.chart,
          computedAt: now.toISOString(),
        });
      }),
  );

  server.registerTool(
    'query_board',
    {
      description: QUERY_GUIDE,
      inputSchema: {
        boardId: z.string().describe('Board id from list_boards'),
        query: z.record(z.string(), z.unknown()).describe('The query object (see the description)'),
      },
      annotations: readOnly,
    },
    async ({ boardId, query }) =>
      guarded(options, async () => {
        const parsed = boardQuerySchema.safeParse(query);
        if (!parsed.success) {
          const issues = parsed.error.issues.map(
            (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
          );
          return failure('invalid_query', `Invalid query: ${issues.join('; ')}`);
        }
        const { board, dataset } = await openBoard(ctx, boardId);
        const now = ctx.now();
        return result({
          board: { id: board.id, name: board.name },
          query: parsed.data,
          data: capRows(runQuery(dataset, parsed.data, { now })),
          computedAt: now.toISOString(),
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
        if (!spec.ok) return failure('invalid_params', `Invalid params: ${spec.issues.join('; ')}`);
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
    'list_sprints',
    {
      description:
        "List a synced board's sprints with their official start, end and completion dates (newest first). Use it for sprint ids, names and dates; never infer sprint dates from issue or worklog dates.",
      inputSchema: {
        boardId: z.string().describe('Board id from list_boards'),
        state: z.enum(['active', 'closed', 'future']).optional().describe('Sprint state to keep'),
        nameContains: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe('Words in the sprint name (case-insensitive)'),
        limit: z.number().int().min(1).max(50).default(20).describe('At most 50 results'),
      },
      annotations: readOnly,
    },
    async ({ boardId, state, nameContains, limit }) =>
      guarded(options, async () =>
        result(await listSprints(ctx, boardId, { state, nameContains, limit })),
      ),
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
        const key = metric as CatalogMetricKey;
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
