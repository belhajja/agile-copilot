'use client';

import { ChevronDown, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { setConversationModelAction } from '@/app/(app)/agent/actions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface ModelOption {
  id: string;
  label: string;
  model: string;
  isDefault: boolean;
}

/**
 * The model of the open conversation, among the workspace's working AI connections. Picking the
 * default connection follows the workspace default (it changes with it).
 */
export function ModelPicker({
  conversationId,
  models,
  pickedId,
  fallback,
  canManage,
}: {
  /** Stored by the first pick when the chat is still new. */
  conversationId: string;
  models: ModelOption[];
  /** The connection picked for this conversation; null = the workspace default. */
  pickedId: string | null;
  /** A model was picked but is gone or failing: the default answers. */
  fallback: boolean;
  canManage: boolean;
}) {
  const t = useTranslations('agent.model');
  const [pending, startTransition] = useTransition();
  const defaultModel = models.find((m) => m.isDefault);
  const current = (!fallback && models.find((m) => m.id === pickedId)) || defaultModel;
  if (!current) return null;

  const pick = (id: string) => {
    if (id === current.id && !fallback) return;
    startTransition(async () => {
      const result = await setConversationModelAction(
        conversationId,
        id === defaultModel?.id ? null : id,
      );
      if (!result.ok) toast.error(t('failed'));
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-56 gap-1 text-muted-foreground"
          disabled={pending}
          aria-label={t('button', { model: current.model })}
          title={fallback ? t('fallback') : t('button', { model: current.model })}
          data-model-picker
        >
          {fallback && <TriangleAlert className="text-amber-600" aria-hidden />}
          <span className="truncate">{current.model}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('menuTitle')}</DropdownMenuLabel>
        {fallback && <p className="px-2 pb-2 text-amber-700 text-xs">{t('fallback')}</p>}
        <DropdownMenuRadioGroup value={current.id} onValueChange={pick}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} className="items-start">
              <span className="grid min-w-0">
                <span className="truncate font-medium">
                  {m.model}
                  {m.isDefault && (
                    <span className="ml-1 font-normal text-muted-foreground">({t('default')})</span>
                  )}
                </span>
                <span className="truncate text-muted-foreground text-xs">{m.label}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {canManage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/llm">{t('manage')}</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
