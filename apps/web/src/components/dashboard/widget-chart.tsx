'use client';

import { useFormatter } from 'next-intl';
import { useId } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import type { SeriesData } from './types';

// Theme chart colours (distinct hues in light and dark themes).
const PALETTE = [1, 2, 3, 4, 5];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Bar/line/area chart for a series widget, adapted from the dashboard-01 interactive area chart. */
export function WidgetChart({
  data,
  labels,
}: {
  data: SeriesData;
  labels: Record<string, string>;
}) {
  const format = useFormatter();
  // Series are told apart by more than colour: every second bar/area series is hatched, and
  // reference lines (ideal, scope) are dashed.
  const uid = useId().replace(/:/g, '');
  const hatchId = (key: string) => `hatch-${uid}-${key}`;
  const hatched = (s: SeriesData['series'][number], i: number) => s.dashed === true || i % 2 === 1;
  const fillOf = (s: SeriesData['series'][number], i: number) =>
    hatched(s, i) ? `url(#${hatchId(s.key)})` : `var(--color-${s.key})`;
  const patterns = (
    <defs key="patterns">
      {data.series.map((s) => (
        <pattern
          key={s.key}
          id={hatchId(s.key)}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={6} fill={`var(--color-${s.key})`} fillOpacity={0.3} />
          <line x1={0} y1={0} x2={0} y2={6} stroke={`var(--color-${s.key})`} strokeWidth={3} />
        </pattern>
      ))}
    </defs>
  );
  const config = Object.fromEntries(
    data.series.map((s, i) => [
      s.key,
      { label: labels[s.key] ?? s.key, color: `var(--chart-${PALETTE[i % PALETTE.length]})` },
    ]),
  ) satisfies ChartConfig;
  const tick = (value: unknown) => {
    const text = String(value);
    return DAY.test(text)
      ? format.dateTime(new Date(`${text}T00:00:00Z`), {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })
      : text;
  };
  const axes = [
    patterns,
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis
      key="x"
      dataKey={data.x}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={24}
      tickFormatter={tick}
    />,
    <YAxis key="y" tickLine={false} axisLine={false} width={32} allowDecimals={false} />,
    <ChartTooltip
      key="tooltip"
      cursor={false}
      content={<ChartTooltipContent labelFormatter={(label) => tick(label)} indicator="dot" />}
    />,
    <ChartLegend key="legend" content={<ChartLegendContent />} />,
  ];

  return (
    <ChartContainer config={config} className="aspect-auto h-[250px] w-full">
      {data.chart === 'bar' ? (
        <BarChart data={data.rows}>
          {axes}
          {data.series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={fillOf(s, i)}
              stroke={`var(--color-${s.key})`}
              strokeDasharray={hatched(s, i) ? '4 2' : undefined}
              radius={4}
              stackId={s.stacked ? 'stack' : undefined}
            />
          ))}
        </BarChart>
      ) : data.chart === 'line' ? (
        <LineChart data={data.rows}>
          {axes}
          {data.series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              dot={false}
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart data={data.rows}>
          {axes}
          {data.series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              fill={fillOf(s, i)}
              fillOpacity={hatched(s, i) ? 1 : 0.4}
              stroke={`var(--color-${s.key})`}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              stackId={s.stacked ? 'stack' : undefined}
            />
          ))}
        </AreaChart>
      )}
    </ChartContainer>
  );
}
