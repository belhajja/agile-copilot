import { getFormatter, getTranslations } from 'next-intl/server';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { TableData } from './types';

const MAX_ROWS = 20;

export async function WidgetTable({ data }: { data: TableData }) {
  const t = await getTranslations('dashboards');
  const format = await getFormatter();
  const code = (c: string) => (t.has(`codes.${c}`) ? t(`codes.${c}`) : c);
  // Percentiles only grow, so when the simulation hit its day cap the last row is capped, and so
  // is any earlier row that shows the same date.
  const cappedDate = data.capped
    ? (data.rows.at(-1)?.[data.columns.findIndex((c) => c.type === 'date')] ?? null)
    : null;
  const cell = (value: string | number | null, type: TableData['columns'][number]['type']) => {
    if (value === null) return '—';
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
      default:
        return String(value);
    }
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {data.columns.map((c) => (
            <TableHead key={c.key}>
              {t.has(`columns.${c.key}`) ? t(`columns.${c.key}`) : c.key}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.rows.slice(0, MAX_ROWS).map((row) => (
          <TableRow key={String(row[0])}>
            {data.columns.map((c, j) => (
              <TableCell
                key={c.key}
                className={c.key === 'summary' ? 'max-w-40 truncate sm:max-w-64' : undefined}
              >
                {cell(row[j] ?? null, c.type)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
