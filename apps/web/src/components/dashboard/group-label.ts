import { useFormatter, useTranslations } from 'next-intl';
import { allowedCode } from '@/lib/error-code';
import { QUERY_GROUPS } from './message-keys';
import { MONTH_FORMAT, monthStart } from './month-label';

/** Query group labels: `@none`, `@other`, `@todo`… are message keys; anything else is Jira data. */
export function useGroupLabel(): (label: string) => string {
  const t = useTranslations('dashboards.query.groups');
  return (label) => {
    const known = label.startsWith('@') ? allowedCode(label.slice(1), QUERY_GROUPS) : null;
    return known ? t(known) : label;
  };
}

/** A group label of a dimension: a month bucket as a localized month, else as a group label. */
export function useDimensionLabel(): (dimension: string | undefined, label: string) => string {
  const format = useFormatter();
  const groupLabel = useGroupLabel();
  return (dimension, label) => {
    const month = dimension ? monthStart(dimension, label) : null;
    return month ? format.dateTime(month, MONTH_FORMAT) : groupLabel(label);
  };
}
