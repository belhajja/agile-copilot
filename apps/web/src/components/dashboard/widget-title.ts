import type { WidgetSpec } from '@agile/dashboards';
import { useTranslations } from 'next-intl';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_METRICS } from './message-keys';

/** A widget's title: its own, else its query's, else its metric's translated name. */
export function useWidgetTitle(): (spec: WidgetSpec) => { title: string; defaultTitle: string } {
  const t = useTranslations('dashboards');
  return (spec) => {
    const metric = allowedCode(spec.metric, DASHBOARD_METRICS);
    // A query widget's params hold filters, not translation values: its title has none to fill in.
    const defaultTitle =
      spec.metric === 'query' && !('unavailable' in spec.params)
        ? spec.params.title
        : metric
          ? t(`metrics.${metric}.title`, spec.metric === 'query' ? undefined : spec.params)
          : spec.metric;
    return { title: spec.title ?? defaultTitle, defaultTitle };
  };
}
