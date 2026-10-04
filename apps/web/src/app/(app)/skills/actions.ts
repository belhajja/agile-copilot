'use server';

import { builderCallsSince, draftSkill, runSkill, SKILL_BUILDER_HOURLY_LIMIT } from '@agile/agent';
import { requestSkillRun } from '@agile/automation';
import { isUuid } from '@agile/db';
import {
  copyBuiltinSkill,
  createSkill,
  deleteSkill,
  forkSkill,
  getSkill,
  getSkillVersion,
  parseSkillDocument,
  type SkillLocale,
  setSkillEnabled,
  setSkillVisibility,
  updateSkill,
} from '@agile/skills';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import { skillQueue, skillRunDeps, skillRunsDailyLimit } from '@/server/automation';
import { requireActor, services } from '@/server/context';
import type { SkillTab } from './skill-errors';

const locale = async (): Promise<SkillLocale> => ((await getLocale()) === 'fr' ? 'fr' : 'en');

/** No silent failures (P4-R11): a refused action comes back to the page with a translated code. */
const fail = (path: string, code: string, tab?: SkillTab): never =>
  redirect(`${path}?error=${encodeURIComponent(code)}${tab ? `&tab=${tab}` : ''}`);

/** A skill that is gone goes back to the list; any other refusal to the skill's own page. */
const failSkill = (id: string, code: string, tab: SkillTab = 'mine'): never =>
  code === 'not_found' ? fail('/skills', code, tab) : fail(`/skills/${id}`, code);

/** Copies a built-in skill into an editable one of the user's, and opens it. */
export async function copyBuiltinSkillAction(key: string): Promise<void> {
  const actor = await requireActor();
  const r = await copyBuiltinSkill(services().db, actor, key, new Date(), await locale());
  if (!r.ok) fail('/skills', r.code, 'library');
  else redirect(`/skills/${r.id}`);
}

/**
 * Copies a skill shared in the workspace into the user's own skills (disabled, P4-R8) and opens
 * the copy. Only the skill's own page offers it, where its full text is shown.
 */
export async function forkSkillAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found', 'shared');
  const r = await forkSkill(services().db, actor, id, new Date(), await locale());
  if (!r.ok) failSkill(id, r.code, 'shared');
  else redirect(`/skills/${r.id}`);
}

export async function setSkillVisibilityAction(
  id: string,
  visibility: 'private' | 'workspace',
): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await setSkillVisibility(services().db, actor, id, visibility);
  if (!r.ok) return failSkill(id, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${id}`);
}

export async function setSkillEnabledAction(id: string, enabled: boolean): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await setSkillEnabled(services().db, actor, id, enabled, new Date());
  if (!r.ok) return failSkill(id, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${id}`);
}

export async function deleteSkillAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await deleteSkill(services().db, actor, id);
  if (!r.ok) return failSkill(id, r.code);
  revalidatePath('/skills');
  redirect('/skills');
}

/** "Run now": queues one run of a scheduled or alert skill, then shows its page. */
export async function runSkillNowAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await requestSkillRun(
    {
      db: services().db,
      boss: await skillQueue(),
      dailyLimit: skillRunsDailyLimit(),
      now: new Date(),
    },
    actor,
    id,
  );
  revalidatePath(`/skills/${id}`);
  redirect(`/skills/${id}?run=${r.ok ? (r.queued ? 'queued' : 'daily_limit') : r.code}`);
}

export type SkillIssueView = { code: string; field?: string };
export type EditorResult =
  | { ok: true; document?: string; text?: string; id?: string; version?: number }
  | { ok: false; code: string; issues?: SkillIssueView[] };

const MAX_REQUEST = 2_000;

/**
 * Drafts and previews spend the workspace's own model budget: at most
 * `SKILL_BUILDER_HOURLY_LIMIT` per member and rolling hour, counted from their metered usage
 * (P4-R16).
 */
async function overBuilderLimit(actor: Awaited<ReturnType<typeof requireActor>>) {
  const since = new Date(Date.now() - 3_600_000);
  return (await builderCallsSince(services().db, actor, since)) >= SKILL_BUILDER_HOURLY_LIMIT;
}

/**
 * The skill builder: the user's request → a draft SKILL.md. Nothing is saved: the draft lands in
 * the editor, where the user reads and edits the full text before saving it.
 */
export async function draftSkillAction(request: string): Promise<EditorResult> {
  const actor = await requireActor();
  const text = String(request ?? '').trim();
  if (!text || text.length > MAX_REQUEST) return { ok: false, code: 'invalid_request' };
  if (await overBuilderLimit(actor)) return { ok: false, code: 'rate_limited' };
  const r = await draftSkill(skillRunDeps(), actor, text);
  return r.ok ? { ok: true, document: r.document } : { ok: false, code: r.code };
}

/**
 * Preview on real data: runs the document once, as the user, read-only (the same run a schedule
 * makes, without delivery). Metered like any reply; not counted against the daily run limit.
 */
export async function previewSkillAction(document: string): Promise<EditorResult> {
  const actor = await requireActor();
  const parsed = parseSkillDocument(String(document ?? ''));
  if (!parsed.ok) return { ok: false, code: 'invalid', issues: parsed.issues };
  if (await overBuilderLimit(actor)) return { ok: false, code: 'rate_limited' };
  const r = await runSkill(skillRunDeps(), actor, { skill: parsed.skill });
  return r.ok ? { ok: true, text: r.text } : { ok: false, code: r.code };
}

/**
 * Only the slack and teams outputs post to a channel: any other output is saved without one (the
 * store refuses a channel there), so switching a skill from Slack to email just works.
 */
function channelFor(document: string, channelId: string | null): string | null {
  const parsed = parseSkillDocument(document);
  const output = parsed.ok ? parsed.skill.frontmatter.output : null;
  return output === 'slack' || output === 'teams' ? channelId : null;
}

const saveSchema = z.object({
  id: z.string().refine(isUuid).optional(),
  document: z.string().max(30_000),
  channelId: z.string().refine(isUuid).nullable(),
  baseVersion: z.number().int().min(1).optional(),
});

/** Creates the skill (then opens it) or saves a new version of it from the version loaded. */
export async function saveSkillAction(input: {
  id?: string;
  document: string;
  channelId: string | null;
  baseVersion?: number;
}): Promise<EditorResult> {
  const actor = await requireActor();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_request' };
  const { id, document, baseVersion } = parsed.data;
  const common = {
    document,
    channelId: channelFor(document, parsed.data.channelId),
    locale: await locale(),
    now: new Date(),
  };
  if (!id) {
    const r = await createSkill(services().db, actor, common);
    if (!r.ok) return { ok: false, code: r.code, issues: r.issues };
    revalidatePath('/skills');
    redirect(`/skills/${r.id}`);
  }
  if (baseVersion === undefined) return { ok: false, code: 'invalid_request' };
  const r = await updateSkill(services().db, actor, id, { ...common, baseVersion });
  if (!r.ok) return { ok: false, code: r.code, issues: r.issues };
  revalidatePath('/skills');
  revalidatePath(`/skills/${id}`);
  return { ok: true, version: r.version };
}

/**
 * Restores an old version: saves its document again as the newest version (N+1), from the
 * version the page showed (`version_conflict` if another tab saved meanwhile).
 */
export async function restoreSkillVersionAction(
  id: string,
  version: number,
  baseVersion: number,
): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const detail = await getSkill(services().db, actor, id);
  if (!detail) return failSkill(id, 'not_found');
  const document = await getSkillVersion(services().db, actor, id, version);
  if (document === null) return fail(`/skills/${id}`, 'not_found');
  const r = await updateSkill(services().db, actor, id, {
    document,
    channelId: channelFor(document, detail.skill.channelId),
    baseVersion,
    locale: await locale(),
    now: new Date(),
  });
  if (!r.ok) return failSkill(id, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${id}`);
  redirect(`/skills/${id}?restored=1`);
}
