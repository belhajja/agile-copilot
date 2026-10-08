'use client';

import type { WorkspaceSettings } from '@agile/privacy';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { pickCode } from '@/lib/error-code';
import { type SettingsState, saveWorkspaceSettingsAction } from './actions';
import { SETTINGS_ERROR_CODES } from './error-codes';

const idle: SettingsState = { status: 'idle' };

export function SettingsForm({
  settings,
  bounds,
  canEdit,
  mcpInPlan,
}: {
  settings: WorkspaceSettings;
  bounds: Record<
    'conversationRetentionDays' | 'usageRetentionDays' | 'auditRetentionDays',
    { min: number; max: number }
  >;
  canEdit: boolean;
  /** The plan includes external MCP (always in self-host); else it cannot be switched on. */
  mcpInPlan: boolean;
}) {
  const t = useTranslations('workspace');
  const [state, action, pending] = useActionState(saveWorkspaceSettingsAction, idle);
  const days = (name: keyof typeof bounds) => (
    <Field>
      <FieldLabel htmlFor={name}>{t(`${name}`)}</FieldLabel>
      <Input
        id={name}
        name={name}
        type="number"
        inputMode="numeric"
        min={bounds[name].min}
        max={bounds[name].max}
        defaultValue={settings[name]}
        disabled={!canEdit}
        required
        className="sm:max-w-40"
      />
      <FieldDescription>
        {t(`${name}Hint`, { min: bounds[name].min, max: bounds[name].max })}
      </FieldDescription>
    </Field>
  );
  return (
    <form action={action}>
      <Card>
        <CardHeader>
          <CardTitle>{t('retentionTitle')}</CardTitle>
          <CardDescription>{t('retentionHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {days('conversationRetentionDays')}
            {days('usageRetentionDays')}
            {days('auditRetentionDays')}
            <Field orientation="horizontal">
              <Checkbox
                id="externalMcpEnabled"
                name="externalMcpEnabled"
                defaultChecked={settings.externalMcpEnabled}
                disabled={!canEdit || (!mcpInPlan && !settings.externalMcpEnabled)}
              />
              <FieldLabel htmlFor="externalMcpEnabled">{t('externalMcp')}</FieldLabel>
            </Field>
            <FieldDescription>
              {mcpInPlan ? t('externalMcpHint') : t('externalMcpNotInPlan')}
            </FieldDescription>
            {state.status === 'error' && (
              <FieldError>{t(`errors.${pickCode(state.code, SETTINGS_ERROR_CODES)}`)}</FieldError>
            )}
            {state.status === 'ok' && <p className="text-sm">{t('saved')}</p>}
            {canEdit && (
              <div>
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending && <Spinner aria-hidden />}
                  {t('save')}
                </Button>
              </div>
            )}
          </FieldGroup>
        </CardContent>
      </Card>
    </form>
  );
}
