import { KpiCards } from './kpi-cards';
import type { RenderedWidget } from './types';
import { WidgetCard } from './widget-card';
import type { WidgetEditing } from './widget-controls';

/** dashboard-01 layout: KPI cards on top, then the chart and table widgets in a responsive grid. */
export function DashboardView({
  widgets,
  editing,
}: {
  widgets: RenderedWidget[];
  /** Set for dashboards whose widgets the user can edit and remove (the "Pinned" one). */
  editing?: WidgetEditing;
}) {
  const kpis = widgets.filter((w) => w.spec.chart === 'kpi');
  const others = widgets.filter((w) => w.spec.chart !== 'kpi');
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {kpis.length > 0 && <KpiCards widgets={kpis} editing={editing} />}
      <div className="grid grid-cols-1 gap-4 @4xl/main:grid-cols-2">
        {others.map((w) => (
          <WidgetCard key={w.spec.id} widget={w} editing={editing} />
        ))}
      </div>
    </div>
  );
}
