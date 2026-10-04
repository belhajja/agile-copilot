'use client';

import type { BoardView } from '@agile/sync';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useState } from 'react';
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { type ActionState, saveBoardSelectionAction } from './actions';

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
      toast.error(t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t('errors.unknown'));
    }
  }, [state, t]);

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
          <ItemGroup className="gap-2">
            {boards.map((b) => {
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
                          b.usesEstimates ? t('estimates.points') : t('estimates.count'),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </ItemDescription>
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
