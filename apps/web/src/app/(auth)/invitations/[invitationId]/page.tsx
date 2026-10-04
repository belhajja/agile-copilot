import { parseRoles, primaryRole } from '@agile/auth/client';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { invitationErrorOf } from '@/lib/sso-error-codes';
import { requireSignedIn, services } from '@/server/context';
import { InvitationButtons } from '../invitation-buttons';

export const dynamic = 'force-dynamic';

/** An invitation link: which workspace invites the signed-in person, with which role. */
export default async function InvitationPage({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  const session = await requireSignedIn(`/invitations/${invitationId}`);
  const t = await getTranslations('invitations');
  const ta = await getTranslations('auth');
  // better-auth answers only for the addressee (and, with SSO, an IdP-verified address).
  const found =
    invitationId.length <= 100
      ? await services()
          .auth.api.getInvitation({ headers: await headers(), query: { id: invitationId } })
          .then((invitation) => ({ invitation, code: null }))
          .catch((e: unknown) => ({ invitation: null, code: invitationErrorOf(e) }))
      : { invitation: null, code: null };
  const { invitation, code } = found;
  const role = invitation ? (primaryRole(parseRoles(invitation.role)) ?? 'viewer') : null;
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">
          {invitation ? t('title', { workspace: invitation.organizationName }) : t('notFound')}
        </CardTitle>
        <CardDescription>
          {role
            ? t('description', { role: t(`roles.${role}`) })
            : code
              ? ta(`errors.${code}`)
              : t('notFoundHint', { email: session.user.email })}
        </CardDescription>
      </CardHeader>
      {invitation && (
        <CardContent>
          <InvitationButtons invitationId={invitation.id} />
        </CardContent>
      )}
    </Card>
  );
}
