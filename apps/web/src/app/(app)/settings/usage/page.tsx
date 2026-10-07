import { usageSummary } from '@agile/agent';
import { can } from '@agile/auth';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SettingsPage } from '@/components/settings/settings-page';
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
type Rows = Awaited<ReturnType<typeof usageSummary>>;

/** KPI cards and the per-person table of one usage source (chat answers, or skill runs/drafts). */
async function UsageSection({
  rows,
  source,
  title,
  hint,
}: {
  rows: Rows;
  source: 'chat' | 'skills';
  title: string;
  hint?: string;
}) {
  const t = await getTranslations('usage');
  const format = await getFormatter();
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
  const count = source === 'chat' ? t('replies') : t('runs');
  return (
    <section className="grid gap-4" data-usage-source={source}>
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      <div className="grid gap-4 @xl/main:grid-cols-3">
        <Card data-kpi="replies">
          <CardHeader>
            <CardDescription>{count}</CardDescription>
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
              <TableHead className="text-right">{count}</TableHead>
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
    </section>
  );
}

/** Spend this month: the workspace's per person for owners/admins, otherwise one's own. */
export default async function UsagePage() {
  const actor = await requireActor();
  const t = await getTranslations('usage');
  const format = await getFormatter();
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const allUsers = can(actor.roles, 'usage.view_all');
  const { db } = services();
  // Skill runs and drafts are shown apart from chat answers: they are not conversations.
  const [chat, skills] = await Promise.all([
    usageSummary(db, actor, { since, allUsers, source: 'chat' }),
    usageSummary(db, actor, { since, allUsers, source: 'skills' }),
  ]);

  return (
    <SettingsPage
      title={t('title')}
      description={
        <span data-usage-scope={allUsers ? 'all' : 'own'}>
          {t(allUsers ? 'introAll' : 'introOwn', {
            month: format.dateTime(since, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          })}
        </span>
      }
    >
      <UsageSection rows={chat} source="chat" title={t('chatSection')} />
      <UsageSection
        rows={skills}
        source="skills"
        title={t('skillsSection')}
        hint={t('skillsHint')}
      />
      <p className="text-sm text-muted-foreground">{t('pricesHint')}</p>
    </SettingsPage>
  );
}
