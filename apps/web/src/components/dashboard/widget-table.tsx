import { useFormatter, useTranslations } from 'next-intl';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { allowedCode } from '@/lib/error-code';
import { useGroupLabel } from './group-label';
import { DASHBOARD_CODES, DASHBOARD_COLUMNS } from './message-keys';
import { MONTH_FORMAT, monthStart } from './month-label';
import type { TableData } from './types';
import { visibleRows } from './visible-rows';

/** Rows can repeat their first cell (a list sorted by status): keys carry the position too. */
const keyedRows = (rows: TableData['rows']) =>
  rows.map((row, i) => ({ row, key: `${i}-${String(row[0])}` }));

export function WidgetTable({ data }: { data: TableData }) {
  const t = useTranslations('dashboards');
  const format = useFormatter();
  const groupLabel = useGroupLabel();
  const columnLabel = (key: string) => {
    const known = allowedCode(key, DASHBOARD_COLUMNS);
    return known ? t(`columns.${known}`) : key;
  };
  const code = (c: string) => {
    const known = allowedCode(c, DASHBOARD_CODES);
    return known ? t(`codes.${known}`) : c;
  };
  // Percentiles only grow, so when the simulation hit its day cap the last row is capped, and so
  // is any earlier row that shows the same date.
  const cappedDate = data.capped
    ? (data.rows.at(-1)?.[data.columns.findIndex((c) => c.type === 'date')] ?? null)
    : null;
  const cell = (value: string | number | null, column: TableData['columns'][number]) => {
    if (value === null) return '—';
    const { type } = column;
    switch (type) {
      case 'days':
        return t('units.days', {
          count: Number(value),
          value: format.number(Number(value), { maximumFractionDigits: 1 }),
        });
      case 'number':
        return format.number(Number(value));
      case 'date':
        if (cappedDate !== null && value === cappedDate) {
          return t('cappedDays', { days: data.maxDays ?? 0 });
        }
        return format.dateTime(new Date(`${value}T00:00:00Z`), {
          dateStyle: 'medium',
          timeZone: 'UTC',
        });
      case 'code':
        return code(String(value));
      case 'codes':
        return String(value).split(',').map(code).join(', ');
      default: {
        const month = monthStart(column.key, String(value));
        return month ? format.dateTime(month, MONTH_FORMAT) : groupLabel(String(value));
      }
    }
  };
  const { rows, truncated } = visibleRows(data.rows);
  return (
    <Table>
      {truncated && (
        <TableCaption data-truncated>
          {t('truncated', {
            shown: format.number(truncated.shown),
            total: format.number(truncated.total),
          })}
        </TableCaption>
      )}
      <TableHeader>
        <TableRow>
          {data.columns.map((c) => (
            <TableHead key={c.key}>{c.label ? groupLabel(c.label) : columnLabel(c.key)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {keyedRows(rows).map(({ row, key }) => (
          <TableRow key={key}>
            {data.columns.map((c, j) => (
              <TableCell
                key={c.key}
                className={c.key === 'summary' ? 'max-w-40 truncate sm:max-w-64' : undefined}
              >
                {cell(row[j] ?? null, c)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
