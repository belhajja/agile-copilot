import { runSkill } from '@agile/agent';
import { canManageConnections, getMemberRoles } from '@agile/auth';
import { skillRuns, skills, user, withOrg } from '@agile/db';
import {
  type DeliveryCode,
  DeliveryError,
  DeliveryInterruptedError,
  digestLabels,
  loadChannel,
  markChannel,
  postWebhook,
  renderDigestEmail,
  type SmtpSecret,
  sendEmail,
} from '@agile/notify';
import { currentDocument, loadSkillsWithDocuments, parseSkillDocument } from '@agile/skills';
import { and, eq } from 'drizzle-orm';
import type { DeliveryOutcome, RunResultCode } from './codes';
import type { AutomationDeps } from './deps';
import { claimRun, finishRun } from './runs';

export type RunOutcome =
  | { status: 'succeeded'; deliveries: Record<string, DeliveryOutcome> }
  | { status: 'failed' | 'skipped'; code: RunResultCode }
  | { status: 'not_claimed' };

/**
 * A claimed run with its skill, the document of the run's version and the delivery snapshot taken
 * when the run was recorded (P4-R5): an edit made since never redirects the run.
 */
async function loadRun(deps: AutomationDeps, orgId: string, runId: string) {
  return withOrg(deps.db, orgId, async (tx) => {
    const [run] = await tx
      .select({
        skillId: skillRuns.skillId,
        version: skillRuns.version,
        trigger: skillRuns.trigger,
        context: skillRuns.context,
        outputKind: skillRuns.outputKind,
        channelId: skillRuns.channelId,
      })
      .from(skillRuns)
      .where(and(eq(skillRuns.orgId, orgId), eq(skillRuns.id, runId)));
    // Its skill was deleted since it was recorded (the run history outlives it, P4-R31).
    if (!run?.skillId) return null;
    const skillId = run.skillId;
    // The shared joined loader (skill + current document); internal use, scoped to this skill.
    const [loaded] = await loadSkillsWithDocuments(
      tx,
      and(eq(skills.orgId, orgId), eq(skills.id, skillId)),
    );
    if (!loaded) return null;
    // The version recorded on the run: the current one unless the skill was edited meanwhile.
    const document =
      loaded.skill.currentVersion === run.version
        ? loaded.document
        : await currentDocument(tx, skillId, run.version);
    return {
      ...run,
      skillId,
      ownerUserId: loaded.skill.ownerUserId,
      enabled: loaded.skill.enabled,
      locale: loaded.skill.locale,
      document,
    };
  });
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

/** The channel's last outcome, best effort: the delivery itself is already decided (M1). */
async function markBestEffort(
  deps: AutomationDeps,
  orgId: string,
  channelId: string,
  code: DeliveryCode | null,
) {
  try {
    await markChannel(deps.db, orgId, channelId, code);
  } catch (e) {
    deps.onError?.(e, 'channel_mark_failed');
  }
}

/**
 * Where the report goes (the run's snapshot). Returns the outcome per output ('sent' or a code), or
 * 'interrupted' when the worker stopped during the delivery (`signal`).
 */
async function deliver(
  deps: AutomationDeps,
  orgId: string,
  run: LoadedRun,
  report: { name: string; text: string; alert: boolean },
  signal?: AbortSignal,
): Promise<Record<string, DeliveryOutcome> | 'interrupted'> {
  const output = run.outputKind;
  if (output !== 'email' && output !== 'slack' && output !== 'teams') {
    // chat (kept on the Skills page) and dashboard_card (shown on the dashboards): stored only.
    return {};
  }
  const labels = digestLabels(run.locale);
  const title = report.alert ? labels.alert(report.name) : labels.report(report.name);
  const link = new URL(`/skills/${run.skillId}`, deps.appUrl).toString();
  const outbound = { allowedPrivateHosts: deps.allowedPrivateHosts, resolve: deps.resolve };
  let channelId: string | null = null;
  let code: DeliveryCode | 'delivery_failed' | null = null;
  try {
    // The channel of the snapshot: the workspace's SMTP server or the Slack/Teams channel the
    // skill used when the run was recorded (P4-R5).
    const channel = run.channelId ? await loadChannel(deps, orgId, { id: run.channelId }) : null;
    if (!channel || channel.kind !== (output === 'email' ? 'smtp' : output)) {
      return { [output]: 'no_channel' };
    }
    channelId = channel.id;
    if (output === 'email') {
      // The owner's account address: emails never go to anyone else (no recipient field exists).
      // Accepted residual (P4-R9): the address is not verified until Phase 5 SSO.
      const [owner] = await deps.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, run.ownerUserId));
      if (!owner) return { email: 'no_recipient' };
      const { html, text } = await renderDigestEmail({
        lang: run.locale === 'fr' ? 'fr' : 'en',
        title,
        body: report.text,
        link,
        linkLabel: labels.open,
        footer: labels.footer(report.name),
      });
      await sendEmail(
        channel.secret as SmtpSecret,
        { to: owner.email, subject: title, html, text },
        { outbound, signal },
      );
    } else {
      if (!('url' in channel.secret)) return { [output]: 'no_channel' };
      // Through the pinned outbound fetch only (no injectable client, P4-R25).
      await postWebhook(
        output,
        channel.secret.url,
        { title, text: report.text, link },
        { outbound, signal, onError: (e, c) => deps.onError?.(e, c) },
      );
    }
  } catch (e) {
    // Stopped mid-send: not the channel's fault, and the run did not finish.
    if (e instanceof DeliveryInterruptedError) return 'interrupted';
    code = 'delivery_failed';
    if (e instanceof DeliveryError) {
      code = e.code;
      // Webhook failures were already reported by postWebhook, with their cause.
      if (output === 'email') deps.onError?.(e, code);
    } else deps.onError?.(e, code);
  }
  // Recorded outside the send's try: a failure here never turns a sent report into a failed one.
  if (channelId && code !== 'delivery_failed') await markBestEffort(deps, orgId, channelId, code);
  return { [output]: code ?? 'sent' };
}

/**
 * Stores the outcome of a run whose report exists (it may be delivered already): retried once,
 * then reported (`finish_failed`) and left to `closeStaleRuns`, never flipped to failed (M1).
 */
async function finishDelivered(
  deps: AutomationDeps,
  orgId: string,
  runId: string,
  now: () => Date,
  outcome: Parameters<typeof finishRun>[4],
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await finishRun(deps.db, orgId, runId, now(), outcome);
      return;
    } catch (e) {
      if (attempt === 1) deps.onError?.(e, 'finish_failed');
    }
  }
}

/**
 * Executes one queued run (the worker's job): claims it, re-checks the skill and its owner, runs
 * it as the owner with read-only tools, stores the report and delivers it. Every outcome is a code.
 */
export async function executeSkillRun(
  deps: AutomationDeps,
  orgId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const clock = () => (deps.now ?? (() => new Date()))();
  if (!(await claimRun(deps.db, orgId, runId, clock()))) return { status: 'not_claimed' };
  const end = async (status: 'failed' | 'skipped', code: RunResultCode): Promise<RunOutcome> => {
    await finishRun(deps.db, orgId, runId, clock(), { status, resultCode: code });
    return { status, code };
  };
  try {
    const run = await loadRun(deps, orgId, runId);
    // Claimed, but its skill is gone: end it rather than leave it running.
    if (!run) return end('skipped', 'skill_deleted');
    if (!run.enabled) return end('skipped', 'disabled');
    // The owner's role today, not when the skill was saved (they may have left or been demoted).
    const roles = await getMemberRoles(deps.db, orgId, run.ownerUserId);
    if (roles.length === 0) return end('skipped', 'owner_left');
    // Slack and Teams are owner/admin outputs (P4-R4): checked again at run time, before any spend.
    if ((run.outputKind === 'slack' || run.outputKind === 'teams') && !canManageConnections(roles))
      return end('failed', 'forbidden_role');
    const parsed = run.document ? parseSkillDocument(run.document) : null;
    if (!parsed?.ok) return end('failed', 'invalid_skill');
    if (signal?.aborted) return end('failed', 'interrupted');
    const result = await runSkill(
      deps,
      { orgId, userId: run.ownerUserId, roles },
      {
        skill: parsed.skill,
        context: run.trigger === 'alert' ? run.context : undefined,
        skillRunId: runId,
        signal,
      },
    );
    if (!result.ok) return end('failed', signal?.aborted ? 'interrupted' : result.code);
    const deliveries = await deliver(
      deps,
      orgId,
      run,
      { name: parsed.skill.frontmatter.name, text: result.text, alert: run.trigger === 'alert' },
      signal,
    );
    if (deliveries === 'interrupted') {
      // The worker is stopping: the run ends now (with its report), not as a stale `running` row.
      await finishDelivered(deps, orgId, runId, clock, {
        status: 'failed',
        resultCode: 'interrupted',
        output: result.text,
      });
      return { status: 'failed', code: 'interrupted' };
    }
    const failed = Object.values(deliveries).some((d) => d !== 'sent');
    await finishDelivered(deps, orgId, runId, clock, {
      status: 'succeeded',
      resultCode: failed ? 'delivery_failed' : null,
      output: result.text,
      deliveries,
    });
    return { status: 'succeeded', deliveries };
  } catch (e) {
    // Any throw (e.g. the skills store, P4-R28) is a failed run with a fixed code.
    deps.onError?.(e, 'skill_run_failed');
    return end('failed', 'internal_error');
  }
}
