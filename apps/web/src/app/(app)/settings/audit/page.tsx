import { can } from '@agile/auth';
import { recentAuditEntries } from '@agile/privacy';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { pickCode } from '@/lib/error-code';
import { requireActor, services } from '@/server/context';

/** Codes with a sentence under `audit.errors` (the throttle refusals of the export). */
const EXPORT_ERROR_CODES = ['export_in_progress', 'export_rate_limited'] as const;

/** Owners and admins: the latest audit entries and the export (CSV or JSON Lines). */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const actor = await requireActor();
  const t = await getTranslations('audit');
  if (!can(actor.roles, 'audit.export')) {
    return <p className="text-muted-foreground">{t('forbidden')}</p>;
  }
  const { error } = await searchParams;
  const failure = error === undefined ? null : pickCode(error, EXPORT_ERROR_CODES);
  const format = await getFormatter();
  const entries = await recentAuditEntries(services().db, actor, 50);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro')}</p>
      </div>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${failure}`)}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('exportTitle')}</CardTitle>
          <CardDescription>{t('exportHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* A plain POST form (never a GET: links elsewhere must not start exports, A-m5); the
              browser downloads the streamed file. */}
          <form action="/api/audit/export" method="post">
            <FieldGroup className="@xl/main:flex-row @xl/main:items-end">
              <Field>
                <FieldLabel htmlFor="audit-from">{t('from')}</FieldLabel>
                <Input id="audit-from" name="from" type="date" />
              </Field>
              <Field>
                <FieldLabel htmlFor="audit-to">{t('to')}</FieldLabel>
                <Input id="audit-to" name="to" type="date" />
              </Field>
              <Field orientation="horizontal" className="@xl/main:w-auto">
                <Button type="submit" name="format" value="csv">
                  {t('downloadCsv')}
                </Button>
                <Button type="submit" name="format" value="json" variant="outline">
                  {t('downloadJson')}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('when')}</TableHead>
            <TableHead>{t('action')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('who')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap">
                {format.dateTime(e.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
              </TableCell>
              <TableCell className="font-mono text-xs">{e.action}</TableCell>
              <TableCell className="hidden sm:table-cell">
                {e.actorName ?? (e.actorUserId ? t('formerMember') : t('system'))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
