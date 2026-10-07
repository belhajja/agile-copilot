import { useTranslations } from 'next-intl';
import { allowedCode } from '@/lib/error-code';
import { QUERY_GROUPS } from './message-keys';

/** Query group labels: `@none`, `@other`, `@todo`… are message keys; anything else is Jira data. */
export function useGroupLabel(): (label: string) => string {
  const t = useTranslations('dashboards.query.groups');
  return (label) => {
    const known = label.startsWith('@') ? allowedCode(label.slice(1), QUERY_GROUPS) : null;
    return known ? t(known) : label;
  };
}
