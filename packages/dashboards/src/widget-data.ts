/** What a widget renders. Labels are message keys (dashboard.series.*, dashboard.columns.*). */
export type KpiFormat = 'number' | 'percent' | 'days' | 'points' | 'issues' | 'per_week';

export type WidgetData =
  | {
      kind: 'kpi';
      value: number | null;
      format: KpiFormat;
      /** Optional footnote (message key under dashboard.hints) with interpolation values. */
      hint?: { key: string; values?: Record<string, string | number> };
    }
  | {
      kind: 'series';
      chart: 'bar' | 'line' | 'area';
      /** Row field holding the x value (a yyyy-mm-dd day or a label). */
      x: string;
      series: { key: string; stacked?: boolean; dashed?: boolean }[];
      rows: Record<string, string | number | null>[];
    }
  | {
      kind: 'table';
      /** `code`/`codes` cells hold message keys (dashboard.codes.*) the UI translates. */
      columns: { key: string; type: 'text' | 'number' | 'days' | 'date' | 'code' | 'codes' }[];
      rows: (string | number | null)[][];
      /** Forecast tables: a percentile hit the simulation's day cap, so the real answer is later. */
      capped?: boolean;
      maxDays?: number;
    }
  | { kind: 'empty'; reason: 'no_sprint' | 'no_data' | 'no_estimates' };
