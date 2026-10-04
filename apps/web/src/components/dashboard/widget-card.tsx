import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_EMPTY_REASONS, DASHBOARD_METRICS, DASHBOARD_SERIES } from './message-keys';
import { RemoveWidget, type WidgetRemoval } from './remove-widget';
import type { RenderedWidget } from './types';
import { WidgetChart } from './widget-chart';
import { WidgetTable } from './widget-table';

export async function WidgetCard({
  widget,
  removal,
}: {
  widget: RenderedWidget;
  removal?: WidgetRemoval;
}) {
  const t = await getTranslations('dashboards');
  const { spec, data } = widget;
  const metric = allowedCode(spec.metric, DASHBOARD_METRICS);
  const emptyReason =
    data.kind === 'empty' ? allowedCode(data.reason, DASHBOARD_EMPTY_REASONS) : null;
  const seriesLabel = (key: string) => {
    const known = allowedCode(key, DASHBOARD_SERIES);
    return known ? t(`series.${known}`) : key;
  };
  const title = spec.title ?? (metric ? t(`metrics.${metric}.title`, spec.params) : spec.metric);
  return (
    <Card data-widget={spec.id} className="min-w-0 @container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {metric && <CardDescription>{t(`metrics.${metric}.description`)}</CardDescription>}
        {removal && <RemoveWidget removal={removal} widgetId={spec.id} />}
      </CardHeader>
      <CardContent className="overflow-x-auto px-2 sm:px-6">
        {data.kind === 'series' && (
          <WidgetChart
            data={data}
            labels={Object.fromEntries(data.series.map((s) => [s.key, seriesLabel(s.key)]))}
          />
        )}
        {data.kind === 'table' && <WidgetTable data={data} />}
        {data.kind === 'empty' && (
          <p className="text-sm text-muted-foreground">
            {emptyReason ? t(`empty.${emptyReason}`) : t('notEnoughData')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
