'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useState, useTransition } from 'react';
import type { ConversationActionResult } from '@/app/(app)/agent/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Asks for a name (a conversation title, a group name); stays open on a refused one. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initial = '',
  maxLength,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initial?: string;
  maxLength: number;
  submitLabel: string;
  onSubmit: (value: string) => Promise<ConversationActionResult>;
}) {
  const t = useTranslations('agent.manage');
  const inputId = useId();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      setError(t('errors.invalid'));
      return;
    }
    startTransition(async () => {
      const result = await onSubmit(value);
      if (result.ok) onOpenChange(false);
      else setError(t(`errors.${result.code}`));
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={inputId}>{label}</Label>
            <Input
              id={inputId}
              value={value}
              maxLength={maxLength}
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
              onChange={(e) => setValue(e.currentTarget.value)}
            />
            {error && (
              <p id={`${inputId}-error`} className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
