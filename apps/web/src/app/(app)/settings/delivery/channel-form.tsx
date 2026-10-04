'use client';

import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { type ChannelFormState, createChannelAction } from './actions';

const KINDS = ['slack', 'teams', 'smtp'] as const;
type Kind = (typeof KINDS)[number];

/** Adds a Slack/Teams webhook or the workspace's SMTP server (tested before it is saved). */
export function ChannelForm() {
  const t = useTranslations('delivery');
  const [state, action, pending] = useActionState<ChannelFormState, FormData>(createChannelAction, {
    status: 'idle',
  });
  const [kind, setKind] = useState<Kind>('slack');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') {
      formRef.current?.reset();
      setKind('slack');
      toast.success(t('saved'));
    }
  }, [state, t]);

  const errorText =
    state.status !== 'error'
      ? null
      : state.code === 'blocked_url' && state.reason && t.has(`errors.blocked.${state.reason}`)
        ? t(`errors.blocked.${state.reason}`, { host: state.host ?? '' })
        : state.code === 'rejected'
          ? t('errors.rejected', { status: String(state.httpStatus ?? '') })
          : t.has(`errors.${state.code}`)
            ? t(`errors.${state.code}`)
            : t('errors.unknown');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('add')}</CardTitle>
        <CardDescription>{t('addHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* onSubmit + startTransition: a <form action> would reset the typed fields on failure. */}
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            startTransition(() => action(data));
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="kind">{t('kind')}</FieldLabel>
              <NativeSelect
                id="kind"
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind)}
              >
                {KINDS.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {t(`kinds.${k}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="channel-name">{t('name')}</FieldLabel>
              <Input id="channel-name" name="name" required maxLength={80} />
            </Field>
            {kind === 'smtp' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="host">{t('host')}</FieldLabel>
                  <Input id="host" name="host" required placeholder="smtp.example.com" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="port">{t('port')}</FieldLabel>
                  <Input id="port" name="port" required inputMode="numeric" defaultValue="587" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="security">{t('security')}</FieldLabel>
                  <NativeSelect id="security" name="security" defaultValue="starttls">
                    {(['starttls', 'tls', 'none'] as const).map((s) => (
                      <NativeSelectOption key={s} value={s}>
                        {t(`securities.${s}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="username">{t('username')}</FieldLabel>
                  <Input id="username" name="username" autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
                  <Input id="password" name="password" type="password" autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="from">{t('from')}</FieldLabel>
                  <Input id="from" name="from" type="email" required />
                  <FieldDescription>{t('smtpHint')}</FieldDescription>
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel htmlFor="url">{t('url')}</FieldLabel>
                <Input id="url" name="url" type="url" required autoComplete="off" />
                <FieldDescription>{t('urlHint')}</FieldDescription>
              </Field>
            )}
            {errorText && <FieldError>{errorText}</FieldError>}
            <Field>
              <Button type="submit" disabled={pending}>
                {t('submit')}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
