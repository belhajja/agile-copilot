'use client';

import { useFormatter } from 'next-intl';
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

// Theme chart colours, ordered for contrast against the card background.
const PALETTE = [2, 4, 1, 3, 5];
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
          {data.series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
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
          {data.series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              fill={`var(--color-${s.key})`}
              fillOpacity={0.4}
              stroke={`var(--color-${s.key})`}
              stackId={s.stacked ? 'stack' : undefined}
            />
          ))}
        </AreaChart>
      )}
    </ChartContainer>
  );
}
