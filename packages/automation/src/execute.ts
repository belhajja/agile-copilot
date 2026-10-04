import { runSkill } from '@agile/agent';
import { canManageConnections, getMemberRoles } from '@agile/auth';
import { skillRuns, skills, user, withOrg } from '@agile/db';
import {
  type DeliveryCode,
  DeliveryError,
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
import type { AutomationDeps } from './deps';
import { claimRun, finishRun } from './runs';

export type RunOutcome =
  | { status: 'succeeded'; deliveries: Record<string, string> }
  | { status: 'failed' | 'skipped'; code: string }
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
    if (!run) return null;
    // The shared joined loader (skill + current document); internal use, scoped to this skill.
    const [loaded] = await loadSkillsWithDocuments(
      tx,
      and(eq(skills.orgId, orgId), eq(skills.id, run.skillId)),
    );
    if (!loaded) return null;
    // The version recorded on the run: the current one unless the skill was edited meanwhile.
    const document =
      loaded.skill.currentVersion === run.version
        ? loaded.document
        : await currentDocument(tx, run.skillId, run.version);
    return {
      ...run,
      ownerUserId: loaded.skill.ownerUserId,
      enabled: loaded.skill.enabled,
      locale: loaded.skill.locale,
      document,
    };
  });
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

/** Where the report goes (the run's snapshot). Returns the outcome per output: 'sent' or a code. */
async function deliver(
  deps: AutomationDeps,
  orgId: string,
  run: LoadedRun,
  report: { name: string; text: string; alert: boolean },
): Promise<Record<string, string>> {
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
  try {
    if (output === 'email') {
      const channel = await loadChannel(deps, orgId, { kind: 'smtp' });
      if (channel?.kind !== 'smtp') return { email: 'no_channel' };
      channelId = channel.id;
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
        { outbound },
      );
    } else {
      const channel = run.channelId ? await loadChannel(deps, orgId, { id: run.channelId }) : null;
      if (!channel || channel.kind !== output || !('url' in channel.secret)) {
        return { [output]: 'no_channel' };
      }
      channelId = channel.id;
      // Through the pinned outbound fetch only (no injectable client, P4-R25).
      await postWebhook(
        output,
        channel.secret.url,
        { title, text: report.text, link },
        { outbound, onError: (e, code) => deps.onError?.(e, code) },
      );
    }
    if (channelId) await markChannel(deps.db, orgId, channelId, null);
    return { [output]: 'sent' };
  } catch (e) {
    let code: DeliveryCode | 'delivery_failed' = 'delivery_failed';
    if (e instanceof DeliveryError) {
      code = e.code;
      // Webhook failures were already reported by postWebhook, with their cause.
      if (output === 'email') deps.onError?.(e, code);
    } else deps.onError?.(e, code);
    if (channelId && code !== 'delivery_failed') {
      await markChannel(deps.db, orgId, channelId, code);
    }
    return { [output]: code };
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
  const end = async (status: 'failed' | 'skipped', code: string): Promise<RunOutcome> => {
    await finishRun(deps.db, orgId, runId, clock(), { status, resultCode: code });
    return { status, code };
  };
  try {
    const run = await loadRun(deps, orgId, runId);
    if (!run) return { status: 'not_claimed' };
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
    const deliveries = await deliver(deps, orgId, run, {
      name: parsed.skill.frontmatter.name,
      text: result.text,
      alert: run.trigger === 'alert',
    });
    const failed = Object.values(deliveries).some((d) => d !== 'sent');
    await finishRun(deps.db, orgId, runId, clock(), {
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
