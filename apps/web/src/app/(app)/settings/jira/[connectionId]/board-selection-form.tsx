'use client';

import type { BoardView } from '@agile/sync';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { allowedCode } from '@/lib/error-code';
import { BOARD_ERROR_CODES } from '../error-codes';
import { type ActionState, saveBoardSelectionAction } from './actions';
import { type BoardFilter, boardTypesIn, filterBoards } from './filter-boards';

const NO_FILTER: BoardFilter = { query: '', type: 'all', selectedOnly: false };

export function BoardSelectionForm({
  connectionId,
  boards,
  canManage,
}: {
  connectionId: string;
  boards: BoardView[];
  canManage: boolean;
}) {
  const t = useTranslations('boards');
  const [selected, setSelected] = useState(
    () => new Set(boards.filter((b) => b.selected).map((b) => b.id)),
  );
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveBoardSelectionAction.bind(null, connectionId),
    { status: 'idle' },
  );

  useEffect(() => {
    if (state.status === 'ok') toast.success(t('selectionSaved'));
    if (state.status === 'error') {
      toast.error(t(`errors.${allowedCode(state.code, BOARD_ERROR_CODES) ?? 'unknown'}`));
    }
  }, [state, t]);

  const [filter, setFilter] = useState<BoardFilter>(NO_FILTER);
  const types = useMemo(() => boardTypesIn(boards), [boards]);
  const shown = useMemo(() => filterBoards(boards, filter, selected), [boards, filter, selected]);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('selectionTitle')}</CardTitle>
        <CardDescription>{t('selectionDescription')}</CardDescription>
      </CardHeader>
      {/* onSubmit + startTransition (not <form action>): React would reset the form after the action. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData();
          for (const id of selected) data.append('board', id);
          startTransition(() => action(data));
        }}
      >
        <CardContent>
          <div className="mb-4 grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <InputGroup className="min-w-48 flex-1">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label={t('filter.search')}
                  placeholder={t('filter.searchPlaceholder')}
                  value={filter.query}
                  onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                  // Enter would submit the form, i.e. save the selection.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.preventDefault();
                  }}
                />
              </InputGroup>
              {types.length > 1 && (
                <NativeSelect
                  aria-label={t('filter.type')}
                  value={filter.type}
                  onChange={(e) =>
                    setFilter((f) => ({ ...f, type: e.target.value as BoardFilter['type'] }))
                  }
                >
                  <NativeSelectOption value="all">{t('filter.allTypes')}</NativeSelectOption>
                  {types.map((type) => (
                    <NativeSelectOption key={type} value={type}>
                      {t(`types.${type}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
              <Label htmlFor="boards-selected-only" className="font-normal">
                <Checkbox
                  id="boards-selected-only"
                  checked={filter.selectedOnly}
                  onCheckedChange={(v) => setFilter((f) => ({ ...f, selectedOnly: v === true }))}
                />
                {t('filter.selectedOnly')}
              </Label>
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('filter.count', {
                shown: shown.length,
                total: boards.length,
                selected: selected.size,
              })}
            </p>
          </div>
          {shown.length === 0 && (
            <div className="grid justify-items-start gap-2 py-4">
              <p className="text-sm text-muted-foreground">{t('filter.noMatch')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFilter(NO_FILTER)}
              >
                {t('filter.clear')}
              </Button>
            </div>
          )}
          <ItemGroup className="gap-2">
            {shown.map((b) => {
              const inputId = `board-${b.id}`;
              return (
                <Item key={b.id} variant="outline" size="sm" asChild>
                  <label htmlFor={inputId}>
                    <ItemMedia>
                      <Checkbox
                        id={inputId}
                        checked={selected.has(b.id)}
                        disabled={!canManage}
                        onCheckedChange={(v) => toggle(b.id, v === true)}
                      />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{b.name}</ItemTitle>
                      <ItemDescription>
                        {[
                          b.projectKey,
                          !b.configured
                            ? t('estimates.pending')
                            : b.usesEstimates
                              ? t('estimates.points')
                              : t('estimates.count'),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </ItemDescription>
                      {b.lastError && (
                        <ItemDescription className="text-destructive" data-board-error>
                          {t(`errors.${allowedCode(b.lastError, BOARD_ERROR_CODES) ?? 'unknown'}`)}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>
                      <Badge variant="outline">{t(`types.${b.type}`)}</Badge>
                    </ItemActions>
                  </label>
                </Item>
              );
            })}
          </ItemGroup>
        </CardContent>
        {canManage && (
          <CardFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {t('saveSelection')}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
