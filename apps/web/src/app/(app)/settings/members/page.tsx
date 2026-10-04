import { can, listPendingInvitations, listWorkspaceMembers, primaryRole, ROLES } from '@agile/auth';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireActor, services } from '@/server/context';
import { InvitationRow } from './invitation-row';
import { InviteForm } from './invite-form';
import { MemberActions } from './member-actions';

/** Who is in the workspace and with which role; owners and admins manage it. */
export default async function MembersPage() {
  const actor = await requireActor();
  const t = await getTranslations('members');
  const tr = await getTranslations('invitations.roles');
  const format = await getFormatter();
  const { db, env } = services();
  const manage = can(actor.roles, 'members.manage');
  const isOwner = primaryRole(actor.roles) === 'owner';
  // Owners can give every role; admins every role but owner (better-auth enforces it too).
  const assignable = ROLES.filter((r) => isOwner || r !== 'owner');
  const [members, invitations] = await Promise.all([
    listWorkspaceMembers(db, actor.orgId),
    manage ? listPendingInvitations(db, actor.orgId) : Promise.resolve([]),
  ]);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro')}</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('person')}</TableHead>
            <TableHead>{t('role')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('joined')}</TableHead>
            {manage && <TableHead className="text-right">{t('actions')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m) => (
            <TableRow key={m.memberId} data-member={m.email}>
              <TableCell>
                <div className="font-medium">{m.name}</div>
                <div className="text-sm text-muted-foreground">{m.email}</div>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" data-role={m.role ?? 'none'}>
                  {m.role ? tr(m.role) : t('noRole')}
                </Badge>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {format.dateTime(m.joinedAt, { dateStyle: 'medium' })}
              </TableCell>
              {manage && (
                <TableCell className="text-right">
                  {m.userId !== actor.userId && (m.role !== 'owner' || isOwner) && (
                    <MemberActions
                      memberId={m.memberId}
                      name={m.name}
                      role={m.role}
                      assignable={assignable}
                    />
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {manage ? (
        <>
          {!env.OIDC_ISSUER && <p className="text-sm text-muted-foreground">{t('noSsoHint')}</p>}
          {invitations.length > 0 && (
            <div className="grid gap-3">
              <h2 className="text-lg font-semibold">{t('pending')}</h2>
              {invitations.map((i) => (
                <InvitationRow
                  key={i.id}
                  id={i.id}
                  email={i.email}
                  role={i.role ? tr(i.role) : t('noRole')}
                  link={new URL(`/invitations/${i.id}`, env.BETTER_AUTH_URL).toString()}
                />
              ))}
            </div>
          )}
          <InviteForm assignable={assignable} />
          <p className="text-sm text-muted-foreground">{t('rolesHint')}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </div>
  );
}
