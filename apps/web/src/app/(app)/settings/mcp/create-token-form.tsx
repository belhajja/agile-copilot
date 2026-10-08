'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { pickCode } from '@/lib/error-code';
import { type CreateTokenState, createTokenAction } from './actions';
import { desktopConfig } from './client-config';
import { MCP_ERROR_CODES } from './error-codes';

const idle: CreateTokenState = { status: 'idle' };

/**
 * Creates a personal token and shows it once, with a ready-made Claude Desktop entry. `endpoint`
 * is null when the app URL is not https (no configuration that would send the token in clear).
 */
export function CreateTokenForm({ endpoint }: { endpoint: string | null }) {
  const t = useTranslations('mcp');
  const [state, action, pending] = useActionState(createTokenAction, idle);
  const [copied, setCopied] = useState(false);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t('createTitle')}</CardTitle>
        <CardDescription>{t('createHint')}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        <form action={action} onSubmit={() => setCopied(false)}>
          <FieldGroup className="@xl/main:flex-row @xl/main:items-end">
            <Field>
              <FieldLabel htmlFor="token-name">{t('name')}</FieldLabel>
              <Input
                id="token-name"
                name="name"
                required
                maxLength={60}
                placeholder="Claude Desktop"
              />
            </Field>
            <Field className="@xl/main:max-w-40">
              <FieldLabel htmlFor="token-expiry">{t('expires')}</FieldLabel>
              <NativeSelect id="token-expiry" name="expiresInDays" defaultValue="90">
                {[30, 90, 365].map((d) => (
                  <NativeSelectOption key={d} value={d}>
                    {t('days', { count: d })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="@xl/main:w-auto">
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending && <Spinner aria-hidden />}
                {t('create')}
              </Button>
            </Field>
          </FieldGroup>
        </form>
        {state.status === 'error' && (
          <FieldError>{t(`errors.${pickCode(state.code, MCP_ERROR_CODES)}`)}</FieldError>
        )}
        {state.status === 'created' && (
          <Alert className="min-w-0">
            <AlertTitle>{t('createdTitle')}</AlertTitle>
            <AlertDescription className="grid min-w-0 gap-3">
              <p>{t('createdHint')}</p>
              <code
                className="min-w-0 max-w-full break-all rounded bg-muted p-2 text-xs"
                data-new-token
              >
                {state.token}
              </code>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(state.token);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? t('copied') : t('copy')}
                </Button>
              </div>
              {endpoint ? (
                <>
                  <p>{t('desktopHint')}</p>
                  <pre
                    className="min-w-0 max-w-full overflow-x-auto rounded bg-muted p-2 text-xs"
                    data-desktop-config
                  >
                    {desktopConfig(endpoint, state.token)}
                  </pre>
                </>
              ) : (
                <p>{t('insecureEndpoint')}</p>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
