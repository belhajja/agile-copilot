import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_METRICS } from './message-keys';
import type { RenderedWidget } from './types';
import { WidgetBody, WidgetNotes } from './widget-body';
import { WidgetControls, type WidgetEditing } from './widget-controls';
import { useWidgetTitle } from './widget-title';

export function WidgetCard({
  widget,
  editing,
}: {
  widget: RenderedWidget;
  editing?: WidgetEditing;
}) {
  const t = useTranslations('dashboards');
  const titleOf = useWidgetTitle();
  const { spec, data } = widget;
  const metric = allowedCode(spec.metric, DASHBOARD_METRICS);
  const { title, defaultTitle } = titleOf(spec);
  return (
    <Card data-widget={spec.id} className="min-w-0 @container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {metric && <CardDescription>{t(`metrics.${metric}.description`)}</CardDescription>}
        {editing && (
          <WidgetControls editing={editing} widget={widget} defaultTitle={defaultTitle} />
        )}
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
