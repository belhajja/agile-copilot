import { can, listWorkspaceMembers } from '@agile/auth';
import { listMcpTokens, mcpAccessProblem } from '@agile/mcp-gateway';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SettingsPage } from '@/components/settings/settings-page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { mcpDeps } from '@/server/mcp';
import { mcpEndpoint } from './client-config';
import { CreateTokenForm } from './create-token-form';
import { MCP_ERROR_CODES } from './error-codes';
import { RevokeTokenButton } from './revoke-token-button';

/** Personal tokens for external MCP clients (read-only analytics of this workspace). */
export default async function McpPage() {
  const actor = await requireActor();
  const t = await getTranslations('mcp');
  const format = await getFormatter();
  const { db, env } = services();
  // Owners and admins see everyone's tokens (to revoke them), with whose they are.
  const everyone = can(actor.roles, 'members.manage');
  const [problem, tokens, members] = await Promise.all([
    mcpAccessProblem(mcpDeps(), actor.orgId, actor.roles),
    listMcpTokens(db, actor),
    everyone ? listWorkspaceMembers(db, actor.orgId) : Promise.resolve([]),
  ]);
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const endpoint = mcpEndpoint(env.BETTER_AUTH_URL);
  const now = new Date();
  return (
    <SettingsPage
      title={t('title')}
      description={
        <span className="wrap-anywhere">
          {t('intro', {
            endpoint: endpoint ?? new URL('/api/mcp', env.BETTER_AUTH_URL).toString(),
          })}
        </span>
      }
    >
      {problem ? (
        <Alert data-mcp-unavailable={problem}>
          <AlertDescription>{t(`errors.${pickCode(problem, MCP_ERROR_CODES)}`)}</AlertDescription>
        </Alert>
      ) : (
        <CreateTokenForm endpoint={endpoint} />
      )}
      {tokens.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              {everyone && <TableHead className="hidden md:table-cell">{t('owner')}</TableHead>}
              <TableHead className="hidden sm:table-cell">{t('lastUsed')}</TableHead>
              <TableHead>{t('state')}</TableHead>
              <TableHead className="text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((k) => {
              const active = !k.revokedAt && k.expiresAt > now;
              return (
                <TableRow key={k.id} data-token={k.name}>
                  <TableCell>
                    <div className="font-medium">{k.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{k.prefix}…</div>
                  </TableCell>
                  {everyone && (
                    <TableCell className="hidden md:table-cell">
                      {k.userId === actor.userId
                        ? t('you')
                        : (names.get(k.userId) ?? t('formerMember'))}
                    </TableCell>
                  )}
                  <TableCell className="hidden sm:table-cell">
                    {k.lastUsedAt ? format.relativeTime(k.lastUsedAt, now) : t('never')}
                  </TableCell>
                  <TableCell>
                    <Badge variant={active ? 'secondary' : 'outline'}>
                      {k.revokedAt
                        ? t('revoked')
                        : active
                          ? t('activeUntil', {
                              date: format.dateTime(k.expiresAt, { dateStyle: 'medium' }),
                            })
                          : t('expired')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {active && <RevokeTokenButton id={k.id} name={k.name} />}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SettingsPage>
  );
}
