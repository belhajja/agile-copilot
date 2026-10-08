import { listInvitationsForEmail, mayCreateWorkspace, ssoProviderId } from '@agile/auth';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { requireSignedIn, services, ssoConfigOf } from '@/server/context';
import { InvitationButtons } from '../invitations/invitation-buttons';
import { CreateWorkspaceForm } from './create-workspace-form';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await requireSignedIn('/onboarding');
  const t = await getTranslations('onboarding');
  const ti = await getTranslations('invitations');
  const tn = await getTranslations('nav');
  // Only for an address the identity provider verified: anyone can type an unverified one. Without
  // SSO nobody is verified; people then join through the invitation link (M5).
  const invitations = session.user.emailVerified
    ? await listInvitationsForEmail(services().db, session.user.email)
    : [];
  const { db, env } = services();
  const sso = ssoConfigOf(env);
  const canCreate =
    env.SIGNUP === 'open' ||
    (await mayCreateWorkspace(db, session.user.id, sso ? ssoProviderId(sso) : null));
  return (
    <>
      {invitations.length > 0 && (
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{ti('pendingTitle')}</CardTitle>
            <CardDescription>{ti('pendingDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ItemGroup className="gap-3">
              {invitations.map((i) => (
                <Item key={i.id} variant="outline" data-invitation={i.id}>
                  <ItemContent>
                    <ItemTitle>{i.organizationName}</ItemTitle>
                    <ItemDescription>{ti(`roles.${i.role ?? 'viewer'}`)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <InvitationButtons invitationId={i.id} />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {canCreate ? (
            <CreateWorkspaceForm />
          ) : (
            <p className="text-center text-sm text-muted-foreground">{t('inviteOnly')}</p>
          )}
        </CardContent>
      </Card>
      {/* The account (sign-in methods, the person's data) is reachable without a workspace (M3). */}
      <Link
        href="/settings/account"
        className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {tn('account')}
      </Link>
    </>
  );
}
