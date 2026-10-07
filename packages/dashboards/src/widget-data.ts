/** What a widget renders. Labels are message keys (dashboard.series.*, dashboard.columns.*). */
export type KpiFormat = 'number' | 'percent' | 'days' | 'points' | 'issues' | 'per_week';

/** A footnote (message key under dashboards.query.notes) with interpolation values. */
export type WidgetNote = { key: string; values?: Record<string, string | number> };

type Common = {
  /** Set when a sprint selection is active but this widget cannot follow it (shown as a note). */
  unfiltered?: true;
  notes?: WidgetNote[];
};

/**
 * Query results use group labels as row values and series labels. A label starting with "@"
 * (`@none`, `@other`, `@todo`, `@in_progress`, `@done`) is a message key under
 * dashboards.query.groups; any other label is Jira data, shown as is.
 */
export type WidgetData = Common &
  (
    | {
        kind: 'kpi';
        value: number | null;
        format: KpiFormat;
        /** Optional footnote (message key under dashboard.hints) with interpolation values. */
        hint?: { key: string; values?: Record<string, string | number> };
        /** Selected sprints compared: each sprint's own value (label = sprint name, shown as is). */
        breakdown?: { label: string; value: number | null }[];
      }
    | {
        kind: 'series';
        chart: 'bar' | 'line' | 'area' | 'pie';
        /** Row field holding the x value (a yyyy-mm-dd day or a label). */
        x: string;
        /** `label`: a literal display name (a sprint's), used instead of the key's message. */
        series: { key: string; label?: string; stacked?: boolean; dashed?: boolean }[];
        rows: Record<string, string | number | null>[];
      }
    | {
        kind: 'table';
        /**
         * `code`/`codes` cells hold message keys (dashboard.codes.*) the UI translates. `label`:
         * a literal header (a pivot table's column), used instead of the key's message.
         */
        columns: {
          key: string;
          type: 'text' | 'number' | 'days' | 'date' | 'code' | 'codes';
          label?: string;
        }[];
        rows: (string | number | null)[][];
        /** Forecast tables: a percentile hit the simulation's day cap, so the real answer is later. */
        capped?: boolean;
        maxDays?: number;
      }
    | {
        kind: 'empty';
        reason: 'no_sprint' | 'no_data' | 'no_estimates' | 'no_match' | 'unavailable';
      }
  );
