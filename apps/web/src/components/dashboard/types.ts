import type { WidgetData, WidgetSpec } from '@agile/dashboards';

/** A widget spec with its computed data, ready to render. */
export interface RenderedWidget {
  spec: WidgetSpec;
  data: WidgetData;
  /** Charts it can be switched to (set where widgets can be edited). */
  charts?: readonly string[];
}

export type SeriesData = Extract<WidgetData, { kind: 'series' }>;
export type TableData = Extract<WidgetData, { kind: 'table' }>;
