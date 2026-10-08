import type { KpiFormat, WidgetData } from '@agile/dashboards';
import { useFormatter, useTranslations } from 'next-intl';
import { allowedCode } from '@/lib/error-code';
import { useDimensionLabel } from './group-label';
import {
  DASHBOARD_EMPTY_REASONS,
  DASHBOARD_HINTS,
  DASHBOARD_NOTES,
  DASHBOARD_SERIES,
} from './message-keys';
import { WidgetChart } from './widget-chart';
import { WidgetTable } from './widget-table';

/** A KPI value in its unit ("19 pts", "95 %", "3.5 days"); — when there is none. */
export function useKpiText(): (format: KpiFormat, value: number | null) => string {
  const t = useTranslations('dashboards');
  const format = useFormatter();
  return (kpiFormat, v) => {
    if (v === null) return '—';
    if (kpiFormat === 'percent')
      return format.number(v, { style: 'percent', maximumFractionDigits: 0 });
    return t(`units.${kpiFormat}`, {
      count: v,
      value: format.number(v, { maximumFractionDigits: 1 }),
    });
  };
}

/** A widget's footnotes (query notes), translated; nothing when it has none. */
export function WidgetNotes({ data }: { data: WidgetData }) {
  const t = useTranslations('dashboards.query.notes');
  const notes = (data.notes ?? []).flatMap((n) => {
    const key = allowedCode(n.key, DASHBOARD_NOTES);
    return key ? [{ key, values: n.values ?? {} }] : [];
  });
  // A pivot can carry the same note twice (one `capped` per dimension).
  const keyed = notes.map((n, i) => ({ ...n, id: `${n.key}-${i}` }));
  if (keyed.length === 0) return null;
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground" data-notes>
      {keyed.map((n) => (
        <li key={n.id}>{t(n.key, n.values)}</li>
      ))}
    </ul>
  );
}

/** What a widget shows, without its card: chart, table, KPI value or why there is nothing. */
export function WidgetBody({ data }: { data: WidgetData }) {
  const t = useTranslations('dashboards');
  const kpiText = useKpiText();
  const dimensionLabel = useDimensionLabel();
  const seriesLabel = (key: string) => {
    const known = allowedCode(key, DASHBOARD_SERIES);
    return known ? t(`series.${known}`) : key;
  };
  switch (data.kind) {
    case 'series':
      return (
        <WidgetChart
          data={data}
          labels={Object.fromEntries(
            data.series.map((s) => [
              s.key,
              s.label ? dimensionLabel(data.pivot, s.label) : seriesLabel(s.key),
            ]),
          )}
        />
      );
    case 'table':
      return <WidgetTable data={data} />;
    case 'kpi': {
      const hintKey = allowedCode(data.hint?.key, DASHBOARD_HINTS);
      return (
        <div className="grid gap-1">
          <p className="text-3xl font-semibold tabular-nums">{kpiText(data.format, data.value)}</p>
          {data.hint && hintKey && (
            <p className="text-sm text-muted-foreground">
              {t(`hints.${hintKey}`, data.hint.values ?? {})}
            </p>
          )}
        </div>
      );
    }
    case 'empty': {
      const reason = allowedCode(data.reason, DASHBOARD_EMPTY_REASONS);
      return (
        <p className="text-sm text-muted-foreground">
          {reason ? t(`empty.${reason}`) : t('notEnoughData')}
        </p>
      );
    }
  }
}
