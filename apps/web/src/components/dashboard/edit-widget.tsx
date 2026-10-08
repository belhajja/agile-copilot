'use client';

import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useId, useState, useTransition } from 'react';
import type { UpdateWidgetActionResult } from '@/app/(app)/boards/[boardId]/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { allowedCode } from '@/lib/error-code';
import { DASHBOARD_CHARTS } from './message-keys';

export type WidgetChanges = { title?: string | null; chart?: string };

const ERRORS = ['not_found', 'invalid_widget', 'unknown'] as const;

/** Rename a widget, or switch it to another chart its definition allows. */
export function EditWidget({
  update,
  widgetId,
  title,
  defaultTitle,
  chart,
  charts,
}: {
  update: (widgetId: string, changes: WidgetChanges) => Promise<UpdateWidgetActionResult>;
  widgetId: string;
  /** The widget's own title, if it has one. */
  title: string | undefined;
  /** What it is called without one. */
  defaultTitle: string;
  chart: string;
  charts: readonly string[];
}) {
  const t = useTranslations('dashboards');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title ?? '');
  const [picked, setPicked] = useState(chart);
  const [error, setError] = useState<(typeof ERRORS)[number] | null>(null);
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    if (next) {
      setName(title ?? '');
      setPicked(chart);
      setError(null);
    }
    setOpen(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const changes: WidgetChanges = {};
    if (name.trim() !== (title ?? '')) changes.title = name.trim() || null;
    if (picked !== chart) changes.chart = picked;
    if (Object.keys(changes).length === 0) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const result = await update(widgetId, changes);
      if (result.ok) setOpen(false);
      else setError(allowedCode(result.code, ERRORS) ?? 'unknown');
    });
  };

  const chartLabel = (c: string) => {
    const known = allowedCode(c, DASHBOARD_CHARTS);
    return known ? t(`charts.${known}`) : c;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('editWidget.action', { title: title ?? defaultTitle })}
          title={t('editWidget.action', { title: title ?? defaultTitle })}
        >
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('editWidget.title')}</DialogTitle>
            <DialogDescription>{t('editWidget.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-title`}>{t('editWidget.name')}</Label>
            <Input
              id={`${id}-title`}
              value={name}
              maxLength={80}
              placeholder={defaultTitle}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </div>
          {charts.length > 1 && (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-chart`}>{t('editWidget.chart')}</Label>
              <NativeSelect
                id={`${id}-chart`}
                className="w-full"
                value={picked}
                onChange={(e) => setPicked(e.currentTarget.value)}
              >
                {charts.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {chartLabel(c)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {t(`editWidget.errors.${error}`)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('editWidget.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {t('editWidget.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
