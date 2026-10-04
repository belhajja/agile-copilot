'use client';

import type { StatusMappingView } from '@agile/sync';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { allowedCode } from '@/lib/error-code';
import { JIRA_CATEGORIES } from '../error-codes';
import { type ActionState, saveStatusMappingAction } from './actions';

type Category = StatusMappingView['category'];
const CATEGORIES: Category[] = ['todo', 'in_progress', 'done'];

/** Jira status → To do / In progress / Done (+ "waiting" for blocked in-progress states). */
export function StatusMappingForm({
  connectionId,
  boardId,
  boardName,
  mappings,
  canManage,
}: {
  connectionId: string;
  boardId: string;
  boardName: string;
  mappings: StatusMappingView[];
  canManage: boolean;
}) {
  const t = useTranslations('boards');
  // The category key comes from Jira: labelled only when it is one we know.
  const categoryLabel = (key: string) => {
    const known = allowedCode(key, JIRA_CATEGORIES);
    return known ? t(`jiraCategories.${known}`) : key;
  };
  const [rows, setRows] = useState(mappings);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveStatusMappingAction.bind(null, connectionId, boardId),
    { status: 'idle' },
  );

  useEffect(() => {
    if (state.status === 'ok') toast.success(t('mappingSaved'));
    if (state.status === 'error') {
      toast.error(t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t('errors.unknown'));
    }
  }, [state, t]);

  const update = (id: string, patch: Partial<Pick<StatusMappingView, 'category' | 'blocked'>>) =>
    setRows((prev) => prev.map((r) => (r.jiraStatusId === id ? { ...r, ...patch } : r)));

  return (
    <Card data-board={boardName}>
      <CardHeader>
        <CardTitle>{t('mappingTitle', { board: boardName })}</CardTitle>
        <CardDescription>{t('mappingDescription')}</CardDescription>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData();
          for (const r of rows) {
            data.append('status', r.jiraStatusId);
            data.set(`category:${r.jiraStatusId}`, r.category);
            if (r.blocked) data.set(`blocked:${r.jiraStatusId}`, 'on');
          }
          startTransition(() => action(data));
        }}
      >
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('mappingColumns.status')}</TableHead>
                <TableHead>{t('mappingColumns.jiraCategory')}</TableHead>
                <TableHead>{t('mappingColumns.mapsTo')}</TableHead>
                <TableHead>{t('mappingColumns.waiting')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.jiraStatusId} data-status={r.statusName}>
                  <TableCell className="font-medium">{r.statusName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{categoryLabel(r.jiraCategory)}</Badge>
                  </TableCell>
                  <TableCell>
                    <NativeSelect
                      size="sm"
                      aria-label={t('mappingColumns.mapsTo')}
                      value={r.category}
                      disabled={!canManage}
                      onChange={(e) =>
                        update(r.jiraStatusId, {
                          category: e.target.value as Category,
                          blocked: e.target.value === 'in_progress' ? r.blocked : false,
                        })
                      }
                    >
                      {CATEGORIES.map((c) => (
                        <NativeSelectOption key={c} value={c}>
                          {t(`categories.${c}`)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={t('mappingColumns.waiting')}
                      checked={r.blocked}
                      disabled={!canManage || r.category !== 'in_progress'}
                      onCheckedChange={(v) => update(r.jiraStatusId, { blocked: v === true })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {canManage && (
          <CardFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {t('saveMapping')}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
