'use client';

import { unstable_rethrow } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { AgentMarkdown } from '@/components/agent/agent-markdown';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { pickCode } from '@/lib/error-code';
import {
  draftSkillAction,
  type EditorResult,
  previewSkillAction,
  saveSkillAction,
} from './actions';
import { afterResult, type EditorState, postsToChannel } from './editor-state';
import { EDITOR_ERROR_CODES, SKILL_ISSUE_CODES } from './skill-errors';

export interface ChannelOption {
  id: string;
  name: string;
  kind: 'smtp' | 'slack' | 'teams';
}

/**
 * The skill builder: describe → draft (AI) → edit the SKILL.md → preview on real data → save.
 * Nothing is saved before "Save": a draft only fills the editor, where the user reads and edits
 * the full text first; the preview runs read-only, without delivery. Slack/Teams channels are
 * offered only to workspace owners/admins (P4-R4; the server checks it again on save).
 */
export function SkillEditor({
  skillId,
  initialDocument,
  baseVersion,
  channels,
  initialChannelId,
  canPostToChannels,
}: {
  skillId?: string;
  initialDocument: string;
  baseVersion?: number;
  channels: ChannelOption[];
  initialChannelId: string | null;
  /** Workspace owners/admins: the slack and teams outputs and their channel. */
  canPostToChannels: boolean;
}) {
  const t = useTranslations('skills.editor');
  const [request, setRequest] = useState('');
  const [state, setState] = useState<EditorState>({
    document: initialDocument,
    drafted: false,
    preview: null,
    version: baseVersion,
    result: null,
  });
  const { document, drafted, preview, version, result } = state;
  const [channelId, setChannelId] = useState(initialChannelId ?? '');
  const [busy, setBusy] = useState<'draft' | 'preview' | 'save' | null>(null);
  const [, startTransition] = useTransition();

  // A channel only goes with the slack and teams outputs: switching away clears it.
  const clearChannelUnlessPosting = (next: string) => {
    if (!postsToChannel(next)) setChannelId('');
  };
  const setDocument = (next: string) => {
    setState((s) => ({ ...s, document: next }));
    clearChannelUnlessPosting(next);
  };
  const showChannel = canPostToChannels && postsToChannel(document);

  const run = (kind: 'draft' | 'preview' | 'save', action: () => Promise<EditorResult>) => {
    setBusy(kind);
    setState((s) => ({ ...s, result: null }));
    startTransition(async () => {
      try {
        const r = await action();
        setState((s) => afterResult(s, kind, r));
        if (r.ok && kind === 'draft' && r.document) clearChannelUnlessPosting(r.document);
        if (r.ok && kind === 'save') toast.success(t('saved'));
      } catch (e) {
        // A redirect (a new skill opens its page) is navigation, not a failure.
        unstable_rethrow(e);
        setState((s) => ({ ...s, result: { ok: false, code: 'unknown' } }));
      } finally {
        setBusy(null);
      }
    });
  };

  const issues = result && !result.ok ? (result.issues ?? []) : [];
  const error =
    result && !result.ok ? t(`errors.${pickCode(result.code, EDITOR_ERROR_CODES)}`) : null;
  const webhookChannels = channels.filter((c) => c.kind !== 'smtp');

  return (
    <div className="grid gap-6">
      {!skillId && (
        <Card>
          <CardHeader>
            <CardTitle>{t('describeTitle')}</CardTitle>
            <CardDescription>{t('describeHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="skill-request">{t('request')}</FieldLabel>
                <Textarea
                  id="skill-request"
                  value={request}
                  maxLength={2_000}
                  onChange={(e) => setRequest(e.target.value)}
                  placeholder={t('requestPlaceholder')}
                />
              </Field>
              <Field>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null || request.trim() === ''}
                  onClick={() => run('draft', () => draftSkillAction(request))}
                >
                  {busy === 'draft' && <Spinner />}
                  {t('draft')}
                </Button>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('documentTitle')}</CardTitle>
          <CardDescription>{t('documentHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {drafted && (
              <Alert data-drafted>
                <AlertDescription>{t('draftedHint')}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="skill-document">{t('document')}</FieldLabel>
              <Textarea
                id="skill-document"
                className="min-h-80 font-mono text-sm"
                value={document}
                spellCheck={false}
                onChange={(e) => setDocument(e.target.value)}
              />
              <FieldDescription>
                {canPostToChannels ? t('fieldsHint') : t('fieldsHintNoChannels')}
              </FieldDescription>
            </Field>
            {showChannel && (
              <Field>
                <FieldLabel htmlFor="skill-channel">{t('channel')}</FieldLabel>
                <NativeSelect
                  id="skill-channel"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                >
                  <NativeSelectOption value="">{t('noChannel')}</NativeSelectOption>
                  {webhookChannels.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.name} ({c.kind === 'slack' ? 'Slack' : 'Teams'})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>{t('channelHint')}</FieldDescription>
              </Field>
            )}
            {error && (
              <FieldError>
                <span className="grid gap-1" data-editor-error>
                  <span>{error}</span>
                  {issues.map((i) => (
                    <span key={`${i.code}:${i.field ?? ''}`}>
                      {i.field ? `${i.field}: ` : ''}
                      {t(`issues.${pickCode(i.code, SKILL_ISSUE_CODES)}`)}
                    </span>
                  ))}
                </span>
              </FieldError>
            )}
            <Field orientation="horizontal" className="flex-wrap">
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                onClick={() => run('preview', () => previewSkillAction(document))}
              >
                {busy === 'preview' && <Spinner />}
                {t('preview')}
              </Button>
              <Button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  run('save', () =>
                    saveSkillAction({
                      id: skillId,
                      document,
                      channelId: (showChannel && channelId) || null,
                      baseVersion: version,
                    }),
                  )
                }
              >
                {busy === 'save' && <Spinner />}
                {t('save')}
              </Button>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
      {preview !== null && (
        <Card data-preview>
          <CardHeader>
            <CardTitle>{t('previewTitle')}</CardTitle>
            <CardDescription>{t('previewHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentMarkdown>{preview}</AgentMarkdown>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
