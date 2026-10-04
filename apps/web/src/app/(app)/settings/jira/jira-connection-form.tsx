'use client';

import { inferDeployment } from '@agile/jira/normalize';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { allowedCode, BLOCKED_REASONS } from '@/lib/error-code';
import { createJiraConnectionAction, type FormState } from './actions';
import { JIRA_ERROR_CODES } from './error-codes';

type Kind = 'cloud_basic' | 'datacenter_pat';

export function JiraConnectionForm({ oauthEnabled }: { oauthEnabled: boolean }) {
  const t = useTranslations('jira');
  const [state, action, pending] = useActionState<FormState, FormData>(createJiraConnectionAction, {
    status: 'idle',
  });
  const [kind, setKind] = useState<Kind>('cloud_basic');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') {
      formRef.current?.reset();
      toast.success(t('saved'));
    }
  }, [state, t]);

  const blockedReason =
    state.status === 'error' && state.code === 'blocked_url'
      ? allowedCode(state.reason, BLOCKED_REASONS)
      : null;
  const errorText =
    state.status !== 'error'
      ? null
      : blockedReason
        ? t(`errors.blocked.${blockedReason}`, { host: state.host ?? '' })
        : t(`errors.${allowedCode(state.code, JIRA_ERROR_CODES) ?? 'unknown'}`);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('add')}</CardTitle>
        <CardDescription>{t('addDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* onSubmit + startTransition instead of <form action>: React resets the form after an action, which would wipe
            the typed fields (and Radix reverts the type radio) after a failed attempt. */}
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            startTransition(() => action(data));
          }}
        >
          <FieldGroup>
            {oauthEnabled && (
              <>
                <Field>
                  {/* Full navigation (not next/link): the route redirects to Atlassian. */}
                  <Button asChild variant="outline">
                    <a href="/api/jira/oauth/start">{t('oauth')}</a>
                  </Button>
                </Field>
                <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                  {t('or')}
                </FieldSeparator>
              </>
            )}
            <Field>
              <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
              <Input id="name" name="name" required maxLength={80} />
            </Field>
            <Field>
              <FieldLabel htmlFor="baseUrl">{t('url')}</FieldLabel>
              <Input
                id="baseUrl"
                name="baseUrl"
                required
                placeholder="https://your-company.atlassian.net"
                onBlur={(e) => {
                  if (e.currentTarget.value) {
                    setKind(
                      inferDeployment(e.currentTarget.value) === 'cloud'
                        ? 'cloud_basic'
                        : 'datacenter_pat',
                    );
                  }
                }}
              />
              <FieldDescription>{t('urlHint')}</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{t('type')}</FieldLegend>
              <RadioGroup name="kind" value={kind} onValueChange={(v) => setKind(v as Kind)}>
                {(['cloud_basic', 'datacenter_pat'] as const).map((k) => (
                  <Field key={k} orientation="horizontal">
                    <RadioGroupItem value={k} id={`kind-${k}`} />
                    <FieldLabel htmlFor={`kind-${k}`} className="font-normal">
                      {k === 'cloud_basic' ? t('cloud') : t('datacenter')}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            {kind === 'cloud_basic' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
                  <Input id="email" name="email" type="email" required autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="apiToken">{t('apiToken')}</FieldLabel>
                  <Input
                    id="apiToken"
                    name="apiToken"
                    type="password"
                    required
                    autoComplete="off"
                  />
                  <FieldDescription>{t('apiTokenHint')}</FieldDescription>
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel htmlFor="token">{t('pat')}</FieldLabel>
                <Input id="token" name="token" type="password" required autoComplete="off" />
                <FieldDescription>{t('patHint')}</FieldDescription>
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
