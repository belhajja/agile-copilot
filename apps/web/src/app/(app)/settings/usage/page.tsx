import { usageSummary } from '@agile/agent';
import { canManageConnections } from '@agile/auth';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireActor, services } from '@/server/context';

/** Spend this month: the workspace's per person for owners/admins, otherwise one's own. */
export default async function UsagePage() {
  const actor = await requireActor();
  const t = await getTranslations('usage');
  const format = await getFormatter();
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const allUsers = canManageConnections(actor.roles);
  const rows = await usageSummary(services().db, actor, { since, allUsers });
  const total = rows.reduce(
    (a, r) => ({
      replies: a.replies + r.replies,
      tokens: a.tokens + r.inputTokens + r.outputTokens,
      cost: a.cost + r.costMicros,
      unpriced: a.unpriced + r.unpricedReplies,
    }),
    { replies: 0, tokens: 0, cost: 0, unpriced: 0 },
  );
  const money = (micros: number) =>
    format.number(micros / 1_000_000, { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground" data-usage-scope={allUsers ? 'all' : 'own'}>
          {t(allUsers ? 'introAll' : 'introOwn', {
            month: format.dateTime(since, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          })}
        </p>
      </div>
      <div className="grid gap-4 @xl/main:grid-cols-3">
        <Card data-kpi="replies">
          <CardHeader>
            <CardDescription>{t('replies')}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{format.number(total.replies)}</CardTitle>
          </CardHeader>
        </Card>
        <Card data-kpi="tokens">
          <CardHeader>
            <CardDescription>{t('tokens')}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{format.number(total.tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card data-kpi="cost">
          <CardHeader>
            <CardDescription>{t('cost')}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{money(total.cost)}</CardTitle>
            {total.unpriced > 0 && (
              <CardDescription>{t('unpriced', { count: total.unpriced })}</CardDescription>
            )}
          </CardHeader>
        </Card>
      </div>
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('person')}</TableHead>
              <TableHead className="text-right">{t('replies')}</TableHead>
              <TableHead className="text-right">{t('inputTokens')}</TableHead>
              <TableHead className="text-right">{t('outputTokens')}</TableHead>
              <TableHead className="text-right">{t('cost')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.userId}>
                <TableCell>{r.name ?? t('formerMember')}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.number(r.replies)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.number(r.inputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.number(r.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(r.costMicros)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-sm text-muted-foreground">{t('pricesHint')}</p>
    </div>
  );
}
