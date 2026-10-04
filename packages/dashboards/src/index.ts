export { computeWidget, FORECAST_SEED } from './compute';
export { loadBoardDataset, type StatusMapping, toMetricIssue } from './dataset';
export { defaultDashboards, kanbanLayout, scrumLayout } from './layouts';
export {
  type DashboardView,
  ensureDefaultDashboards,
  listDashboards,
  saveDashboardWidgets,
} from './store';
export type { KpiFormat, WidgetData } from './widget-data';
export {
  METRIC_KEYS,
  type MetricKey,
  parseWidgets,
  type WidgetSpec,
  type WidgetSpecInput,
  widgetListSchema,
  widgetSpecSchema,
} from './widget-spec';
