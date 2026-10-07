'use client';

import { Check, ChevronsUpDown, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { MAX_SPRINTS, sprintsHref, toggleSprint } from './sprint-selection';

export interface SprintOption {
  id: string;
  name: string;
  state: 'future' | 'active' | 'closed';
  /** Formatted on the server ("6 Oct – 20 Oct"), null for sprints without dates. */
  dates: string | null;
}

/**
 * Picks the sprints the whole dashboard is scoped to. The choice lives in the URL (`sprints`), so
 * the page re-renders on the server and the link can be shared.
 */
export function SprintPicker({
  options,
  selected,
}: {
  /** Newest first: future sprints, then by start date descending. */
  options: SprintOption[];
  /** Chronological, as the server resolved them. */
  selected: string[];
}) {
  const t = useTranslations('dashboards.sprintFilter');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();
  const byId = new Map(options.map((o) => [o.id, o]));
  const go = (next: string[]) =>
    startTransition(() => {
      router.replace(sprintsHref(pathname, search.toString(), next), { scroll: false });
    });
  const full = selected.length >= MAX_SPRINTS;

  return (
    <div className="flex flex-wrap items-center gap-2" data-sprint-picker aria-busy={pending}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            {t('button')}
            {selected.length > 0 && <Badge variant="secondary">{selected.length}</Badge>}
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <Command>
            <CommandInput placeholder={t('search')} />
            <CommandList>
              <CommandEmpty>{t('none')}</CommandEmpty>
              <CommandGroup heading={full ? t('limit', { max: MAX_SPRINTS }) : undefined}>
                {options.map((o) => {
                  const on = selected.includes(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      value={`${o.name} ${o.id}`}
                      disabled={!on && full}
                      onSelect={() => go(toggleSprint(selected, o.id))}
                    >
                      <Check className={cn('size-4', on ? 'opacity-100' : 'opacity-0')} />
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {o.dates ?? t(`states.${o.state}`)}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t('allSprints')}</span>
      ) : (
        <>
          {selected.map((id) => {
            const name = byId.get(id)?.name ?? id;
            return (
              <Badge key={id} variant="secondary" className="gap-1 pr-1">
                {name}
                <button
                  type="button"
                  className="rounded-sm opacity-70 hover:opacity-100"
                  aria-label={t('remove', { name })}
                  onClick={() => go(toggleSprint(selected, id))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            );
          })}
          <Button variant="ghost" size="sm" onClick={() => go([])}>
            {t('clear')}
          </Button>
        </>
      )}
    </div>
  );
}
