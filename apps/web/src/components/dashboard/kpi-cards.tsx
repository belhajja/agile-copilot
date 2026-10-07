import { useTranslations } from 'next-intl';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_EMPTY_REASONS, DASHBOARD_HINTS, DASHBOARD_METRICS } from './message-keys';
import { RemoveWidget, type WidgetRemoval } from './remove-widget';
import type { RenderedWidget } from './types';
import { useKpiText, WidgetNotes } from './widget-body';

/** Sprint names can repeat: keys carry the position too. */
const keyed = <T extends { label: string }>(items: T[]) =>
  items.map((item, i) => ({ ...item, key: `${i}-${item.label}` }));

/** KPI row, adapted from the shadcn dashboard-01 block's SectionCards. */
export function KpiCards({
  widgets,
  removal,
}: {
  widgets: RenderedWidget[];
  removal?: WidgetRemoval;
}) {
  const t = useTranslations('dashboards');
  const formatted = useKpiText();

  const title = ({ spec }: RenderedWidget): string => {
    const metric = allowedCode(spec.metric, DASHBOARD_METRICS);
    // A query widget's params hold filters, not translation values: the title has none to fill in.
    return (
      spec.title ??
      (metric
        ? t(`metrics.${metric}.title`, spec.metric === 'query' ? undefined : spec.params)
        : spec.metric)
    );
  };
  const value = ({ data }: RenderedWidget): string =>
    data.kind === 'kpi' ? formatted(data.format, data.value) : '—';
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
            {w.data.kind === 'kpi' && w.data.breakdown && (
              <ul className="grid w-full gap-0.5 text-xs" data-breakdown>
                {keyed(w.data.breakdown).map((b) => (
                  <li key={b.key} className="flex justify-between gap-3">
                    <span className="truncate text-muted-foreground">{b.label}</span>
                    <span className="tabular-nums">
                      {formatted(
                        (w.data as Extract<typeof w.data, { kind: 'kpi' }>).format,
                        b.value,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <WidgetNotes data={w.data} />
            {w.data.unfiltered && (
              <div className="text-xs text-muted-foreground" data-unfiltered>
                {t('notSprintFiltered')}
              </div>
            )}
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
