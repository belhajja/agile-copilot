import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RenderedWidget } from './types';
import { WidgetChart } from './widget-chart';
import { WidgetTable } from './widget-table';

export async function WidgetCard({ widget }: { widget: RenderedWidget }) {
  const t = await getTranslations('dashboards');
  const { spec, data } = widget;
  const title =
    spec.title ??
    (t.has(`metrics.${spec.metric}.title`)
      ? t(`metrics.${spec.metric}.title`, spec.params)
      : spec.metric);
  return (
    <Card data-widget={spec.id} className="min-w-0 @container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {t.has(`metrics.${spec.metric}.description`) && (
          <CardDescription>{t(`metrics.${spec.metric}.description`)}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto px-2 sm:px-6">
        {data.kind === 'series' && (
          <WidgetChart
            data={data}
            labels={Object.fromEntries(
              data.series.map((s) => [
                s.key,
                t.has(`series.${s.key}`) ? t(`series.${s.key}`) : s.key,
              ]),
            )}
          />
        )}
        {data.kind === 'table' && <WidgetTable data={data} />}
        {data.kind === 'empty' && (
          <p className="text-sm text-muted-foreground">
            {t.has(`empty.${data.reason}`) ? t(`empty.${data.reason}`) : t('notEnoughData')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
