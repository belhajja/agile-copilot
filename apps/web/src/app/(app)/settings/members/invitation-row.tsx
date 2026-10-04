'use client';

import { Check, Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';

/**
 * A pending invitation. There is no platform mail sender: the admin copies the link and sends it
 * (the invitee signs in, with SSO when it is on, using the invited address).
 */
export function InvitationRow({
  id,
  email,
  role,
  link,
}: {
  id: string;
  email: string;
  role: string;
  link: string;
}) {
  const t = useTranslations('members');
  const router = useRouter();
  const errorMessage = useAuthErrorMessage();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Item variant="outline" data-invitation={email}>
      <ItemContent>
        <ItemTitle>{email}</ItemTitle>
        <ItemDescription>{role}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setError(errorMessage(null));
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t('copied') : t('copyLink')}
        </Button>
        <ConfirmDeleteButton
          labels={{
            trigger: t('cancelInvitation'),
            title: t('cancelInvitationTitle', { email }),
            description: t('cancelInvitationDescription'),
            confirm: t('cancelInvitation'),
            cancel: t('cancel'),
          }}
          onConfirm={async () => {
            const { error } = await authClient.organization.cancelInvitation({ invitationId: id });
            if (error) return setError(errorMessage(error));
            router.refresh();
          }}
        />
      </ItemActions>
      {error && <FieldError className="basis-full">{error}</FieldError>}
    </Item>
  );
}
