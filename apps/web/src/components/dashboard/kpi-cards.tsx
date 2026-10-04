import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_EMPTY_REASONS, DASHBOARD_HINTS, DASHBOARD_METRICS } from './message-keys';
import { RemoveWidget, type WidgetRemoval } from './remove-widget';
import type { RenderedWidget } from './types';

/** KPI row, adapted from the shadcn dashboard-01 block's SectionCards. */
export async function KpiCards({
  widgets,
  removal,
}: {
  widgets: RenderedWidget[];
  removal?: WidgetRemoval;
}) {
  const t = await getTranslations('dashboards');
  const format = await getFormatter();

  const title = ({ spec }: RenderedWidget): string => {
    const metric = allowedCode(spec.metric, DASHBOARD_METRICS);
    return spec.title ?? (metric ? t(`metrics.${metric}.title`, spec.params) : spec.metric);
  };
  const value = ({ data }: RenderedWidget): string => {
    if (data.kind !== 'kpi' || data.value === null) return '—';
    if (data.format === 'percent') {
      return format.number(data.value, { style: 'percent', maximumFractionDigits: 0 });
    }
    return t(`units.${data.format}`, {
      count: data.value,
      value: format.number(data.value, { maximumFractionDigits: 1 }),
    });
  };
  const hint = ({ data }: RenderedWidget): string | null => {
    if (data.kind === 'empty') {
      const reason = allowedCode(data.reason, DASHBOARD_EMPTY_REASONS);
      return reason ? t(`empty.${reason}`) : t('notEnoughData');
    }
    if (data.kind !== 'kpi') return null;
    if (data.value === null) return t('notEnoughData');
    const hintKey = allowedCode(data.hint?.key, DASHBOARD_HINTS);
    if (data.hint && hintKey) return t(`hints.${hintKey}`, data.hint.values ?? {});
    return null;
  };

  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {widgets.map((w) => (
        <Card key={w.spec.id} className="@container/card" data-widget={w.spec.id}>
          <CardHeader>
            <CardDescription>{title(w)}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {value(w)}
            </CardTitle>
            {removal && <RemoveWidget removal={removal} widgetId={w.spec.id} />}
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <div className="text-muted-foreground">{hint(w)}</div>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
