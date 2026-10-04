import { canManageConnections } from '@agile/auth';
import { listRuns } from '@agile/automation';
import { listDeliveryChannels } from '@agile/notify';
import { getSkill } from '@agile/skills';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AgentMarkdown } from '@/components/agent/agent-markdown';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { pickCode } from '@/lib/error-code';
import { requireActor, services } from '@/server/context';
import {
  deleteSkillAction,
  forkSkillAction,
  restoreSkillVersionAction,
  runSkillNowAction,
  setSkillEnabledAction,
  setSkillVisibilityAction,
} from '../actions';
import { SkillBadges } from '../skill-badges';
import { SkillEditor } from '../skill-editor';
import {
  DELIVERY_OUTCOMES,
  DELIVERY_OUTPUTS,
  RUN_REQUEST_CODES,
  SKILL_ERROR_CODES,
  visibleResultCode,
} from '../skill-errors';

type Query = string | string[] | undefined;

/**
 * One skill: its full text (the only place a shared skill can be copied from, P4-R8), the editor
 * and versions for its owner, "Run now", on/off, sharing, deletion and the latest runs. Reports
 * and delivery details are the owner's only (P4-R1).
 */
export default async function SkillPage({
  params,
  searchParams,
}: {
  params: Promise<{ skillId: string }>;
  searchParams: Promise<{ run?: Query; error?: Query; restored?: Query }>;
}) {
  const actor = await requireActor();
  const { skillId } = await params;
  const query = await searchParams;
  const { db } = services();
  const detail = await getSkill(db, actor, skillId);
  if (!detail) notFound();
  const t = await getTranslations('skills');
  const format = await getFormatter();
  const { skill } = detail;
  const owner = detail.canEdit;
  const canPostToChannels = canManageConnections(actor.roles);
  const [channels, runs] = await Promise.all([
    owner && canPostToChannels ? listDeliveryChannels(db, actor.orgId) : Promise.resolve([]),
    listRuns(db, actor, skill.id, 10),
  ]);
  const runnable = skill.trigger === 'schedule' || skill.trigger === 'alert';
  const run = query.run === undefined ? null : pickCode(query.run, RUN_REQUEST_CODES);
  const error = query.error === undefined ? null : pickCode(query.error, SKILL_ERROR_CODES);

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-2">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight break-all">
          {skill.name}
          <SkillBadges skill={skill} />
        </h1>
        <p className="text-muted-foreground">{skill.description}</p>
        {!owner && (
          <p className="text-sm text-muted-foreground">
            {t('by', { name: skill.ownerName ?? t('formerMember') })}
          </p>
        )}
      </div>
      {error && (
        <Alert variant="destructive" data-error={error}>
          <AlertDescription>{t(`errors.${error}`)}</AlertDescription>
        </Alert>
      )}
      {run && (
        <Alert variant={run === 'queued' ? 'default' : 'destructive'} data-run-request={run}>
          <AlertDescription>{t(`runRequest.${run}`)}</AlertDescription>
        </Alert>
      )}
      {query.restored === '1' && (
        <Alert data-restored>
          <AlertDescription>{t('restored')}</AlertDescription>
        </Alert>
      )}
      {owner && skill.forkedFromId && !skill.enabled && (
        <Alert data-enable-copy>
          <AlertDescription>{t('enableCopyHint')}</AlertDescription>
        </Alert>
      )}
      {owner && runnable && !skill.enabled && !skill.forkedFromId && (
        <Alert data-run-now-off>
          <AlertDescription>{t('runNowOff')}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {owner && runnable && skill.enabled && (
          <form action={runSkillNowAction.bind(null, skill.id)}>
            <Button size="sm">{t('runNow')}</Button>
          </form>
        )}
        {owner && (
          <>
            <form action={setSkillEnabledAction.bind(null, skill.id, !skill.enabled)}>
              <Button size="sm" variant="outline">
                {skill.enabled ? t('disable') : t('enable')}
              </Button>
            </form>
            <form
              action={setSkillVisibilityAction.bind(
                null,
                skill.id,
                skill.visibility === 'workspace' ? 'private' : 'workspace',
              )}
            >
              <Button size="sm" variant="outline">
                {skill.visibility === 'workspace' ? t('unshare') : t('share')}
              </Button>
            </form>
          </>
        )}
        {!owner && (
          <form action={forkSkillAction.bind(null, skill.id)}>
            <Button size="sm">{t('copy')}</Button>
          </form>
        )}
        {detail.canDelete && (
          <ConfirmDeleteButton
            onConfirm={deleteSkillAction.bind(null, skill.id)}
            labels={{
              trigger: t('delete'),
              title: t('deleteTitle'),
              description: t('deleteDescription', { name: skill.name }),
              confirm: t('delete'),
              cancel: t('cancel'),
            }}
          />
        )}
      </div>
      {owner ? (
        <SkillEditor
          // A restore (or a save in another tab) makes a new current version: start from it.
          key={skill.currentVersion}
          skillId={skill.id}
          initialDocument={detail.document}
          baseVersion={skill.currentVersion}
          channels={channels.map(({ id, name, kind }) => ({ id, name, kind }))}
          initialChannelId={skill.channelId}
          canPostToChannels={canPostToChannels}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('editor.document')}</CardTitle>
            <CardDescription>{t('copyHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre
              className="overflow-x-auto text-sm whitespace-pre-wrap break-words"
              data-skill-text
            >
              {detail.document}
            </pre>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('runsTitle')}</CardTitle>
          <CardDescription>{owner ? t('runsHint') : t('runsHintOthers')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {runs.length === 0 && <p className="text-sm text-muted-foreground">{t('noRuns')}</p>}
          {runs.map((r, i) => {
            const resultCode = visibleResultCode(r, owner);
            return (
              <div
                key={r.id}
                className="grid gap-2 border-b pb-4 last:border-b-0"
                data-run={r.status}
              >
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>
                    {t(`runStatus.${r.status}`)}
                  </Badge>
                  <span>{t(`runTriggers.${r.trigger}`)}</span>
                  <span className="text-muted-foreground">
                    {format.dateTime(r.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                  {resultCode && (
                    <span className="text-muted-foreground" data-result-code={resultCode}>
                      {t(`resultCodes.${resultCode}`)}
                    </span>
                  )}
                </p>
                {/* Delivery details and reports: the owner's only (P4-R1). */}
                {owner &&
                  Object.entries(r.deliveries)
                    .filter(([channel]) => DELIVERY_OUTPUTS.some((o) => o === channel))
                    .map(([channel, outcome]) => (
                      <p
                        key={channel}
                        className="text-sm text-muted-foreground"
                        data-delivery={channel}
                      >
                        {t('delivered', {
                          channel: t(`outputs.${pickCode(channel, DELIVERY_OUTPUTS)}`),
                          outcome: t(`deliveryOutcomes.${pickCode(outcome, DELIVERY_OUTCOMES)}`),
                        })}
                      </p>
                    ))}
                {owner && i === 0 && r.output && (
                  <div className="rounded-md border p-3" data-run-output>
                    <AgentMarkdown>{r.output}</AgentMarkdown>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('versionsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {detail.versions.map((v) => (
            <div key={v.version} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{t('version', { version: v.version })}</span>
              <span className="text-muted-foreground">
                {format.dateTime(v.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              {v.version === skill.currentVersion ? (
                <Badge variant="outline">{t('current')}</Badge>
              ) : (
                owner && (
                  <form
                    action={restoreSkillVersionAction.bind(
                      null,
                      skill.id,
                      v.version,
                      skill.currentVersion,
                    )}
                  >
                    <Button size="sm" variant="ghost">
                      {t('restore')}
                    </Button>
                  </form>
                )
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
