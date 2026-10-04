import { type WidgetSpec, type WidgetSpecInput, widgetSpecSchema } from './widget-spec';

const build = (specs: WidgetSpecInput[]): WidgetSpec[] =>
  specs.map((s) => widgetSpecSchema.parse(s));

/** Default Scrum dashboard: sprint KPIs, velocity, burndown/burnup, hygiene. */
export const scrumLayout = (): WidgetSpec[] =>
  build([
    { id: 'avg-velocity', metric: 'average_velocity', chart: 'kpi' },
    { id: 'say-do', metric: 'say_do_ratio', chart: 'kpi' },
    { id: 'scope-added', metric: 'scope_change', chart: 'kpi' },
    { id: 'carry-over', metric: 'carry_over', chart: 'kpi' },
    { id: 'velocity', metric: 'velocity', chart: 'bar' },
    { id: 'burndown', metric: 'sprint_burndown', chart: 'line' },
    { id: 'burnup', metric: 'sprint_burnup', chart: 'line' },
    { id: 'hygiene', metric: 'hygiene', chart: 'table' },
  ]);

/** Default Kanban (flow) dashboard: flow KPIs, throughput, CFD, aging WIP, forecasts, hygiene. */
export const kanbanLayout = (): WidgetSpec[] =>
  build([
    { id: 'throughput-rate', metric: 'throughput_rate', chart: 'kpi' },
    { id: 'cycle-time', metric: 'cycle_time', chart: 'kpi' },
    { id: 'wip', metric: 'wip', chart: 'kpi' },
    { id: 'flow-efficiency', metric: 'flow_efficiency', chart: 'kpi' },
    { id: 'throughput', metric: 'throughput', chart: 'bar' },
    { id: 'cfd', metric: 'cfd', chart: 'area' },
    { id: 'aging-wip', metric: 'aging_wip', chart: 'table' },
    { id: 'forecast-how-many', metric: 'forecast_how_many', chart: 'table' },
    { id: 'forecast-when', metric: 'forecast_when', chart: 'table' },
    { id: 'hygiene', metric: 'hygiene', chart: 'table' },
  ]);

/**
 * Boards with sprints (Scrum, and team-managed boards whose project uses sprints) get a sprint
 * dashboard and a flow dashboard; the others a flow one.
 */
export function defaultDashboards(boardType: 'scrum' | 'kanban' | 'simple', hasSprints = false) {
  const flow = { name: 'Flow', kind: 'kanban' as const, widgets: kanbanLayout() };
  return boardType === 'scrum' || (boardType === 'simple' && hasSprints)
    ? [{ name: 'Scrum', kind: 'scrum' as const, widgets: scrumLayout() }, flow]
    : [flow];
}
