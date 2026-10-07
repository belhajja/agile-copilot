import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_METRICS } from './message-keys';
import { RemoveWidget, type WidgetRemoval } from './remove-widget';
import type { RenderedWidget } from './types';
import { WidgetBody, WidgetNotes } from './widget-body';

export function WidgetCard({
  widget,
  removal,
}: {
  widget: RenderedWidget;
  removal?: WidgetRemoval;
}) {
  const t = useTranslations('dashboards');
  const { spec, data } = widget;
  const metric = allowedCode(spec.metric, DASHBOARD_METRICS);
  // A query widget's params hold filters, not translation values: the title has none to fill in.
  const title =
    spec.title ??
    (metric
      ? t(`metrics.${metric}.title`, spec.metric === 'query' ? undefined : spec.params)
      : spec.metric);
  return (
    <Card data-widget={spec.id} className="min-w-0 @container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {metric && <CardDescription>{t(`metrics.${metric}.description`)}</CardDescription>}
        {removal && <RemoveWidget removal={removal} widgetId={spec.id} />}
      </CardHeader>
      <CardContent className="overflow-x-auto px-2 sm:px-6">
        {data.kind !== 'kpi' && <WidgetBody data={data} />}
      </CardContent>
      <div className="px-6 pb-2">
        <WidgetNotes data={data} />
      </div>
      {data.unfiltered && (
        <p className="px-6 pb-4 text-xs text-muted-foreground" data-unfiltered>
          {t('notSprintFiltered')}
        </p>
      )}
    </Card>
  );
}
