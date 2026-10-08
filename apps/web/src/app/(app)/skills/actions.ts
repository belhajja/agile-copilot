'use server';

import { draftSkill, reserveBuilderCall, runSkill } from '@agile/agent';
import { requestSkillRun } from '@agile/automation';
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
import { uuid } from '@/server/action-input';
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

const builtinKey = z.string().min(1).max(100);
const version = z.number().int().min(1);

/** Copies a built-in skill into an editable one of the user's, and opens it. */
export async function copyBuiltinSkillAction(key: unknown): Promise<void> {
  const actor = await requireActor();
  const parsed = builtinKey.safeParse(key);
  if (!parsed.success) return fail('/skills', 'not_found', 'library');
  const r = await copyBuiltinSkill(services().db, actor, parsed.data, new Date(), await locale());
  if (!r.ok) fail('/skills', r.code, 'library');
  else redirect(`/skills/${r.id}`);
}

/**
 * Copies a skill shared in the workspace into the user's own skills (disabled, P4-R8) and opens
 * the copy. Only the skill's own page offers it, where its full text is shown.
 */
export async function forkSkillAction(id: unknown): Promise<void> {
  const actor = await requireActor();
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return fail('/skills', 'not_found', 'shared');
  const r = await forkSkill(services().db, actor, parsed.data, new Date(), await locale());
  if (!r.ok) failSkill(parsed.data, r.code, 'shared');
  else redirect(`/skills/${r.id}`);
}

export async function setSkillVisibilityAction(id: unknown, visibility: unknown): Promise<void> {
  const actor = await requireActor();
  const parsedId = uuid.safeParse(id);
  if (!parsedId.success) return fail('/skills', 'not_found');
  const parsed = z.enum(['private', 'workspace']).safeParse(visibility);
  if (!parsed.success) return failSkill(parsedId.data, 'invalid');
  const r = await setSkillVisibility(services().db, actor, parsedId.data, parsed.data);
  if (!r.ok) return failSkill(parsedId.data, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${parsedId.data}`);
}

export async function setSkillEnabledAction(id: unknown, enabled: unknown): Promise<void> {
  const actor = await requireActor();
  const parsedId = uuid.safeParse(id);
  if (!parsedId.success) return fail('/skills', 'not_found');
  const parsed = z.boolean().safeParse(enabled);
  if (!parsed.success) return failSkill(parsedId.data, 'invalid');
  const r = await setSkillEnabled(services().db, actor, parsedId.data, parsed.data, new Date());
  if (!r.ok) return failSkill(parsedId.data, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${parsedId.data}`);
}

export async function deleteSkillAction(rawId: unknown): Promise<void> {
  const actor = await requireActor();
  const parsed = uuid.safeParse(rawId);
  if (!parsed.success) return fail('/skills', 'not_found');
  const id = parsed.data;
  const r = await deleteSkill(services().db, actor, id);
  if (!r.ok) return failSkill(id, r.code);
  revalidatePath('/skills');
  redirect('/skills');
}

/** "Run now": queues one run of a scheduled or alert skill, then shows its page. */
export async function runSkillNowAction(rawId: unknown): Promise<void> {
  const actor = await requireActor();
  const parsed = uuid.safeParse(rawId);
  if (!parsed.success) return fail('/skills', 'not_found');
  const id = parsed.data;
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
  redirect(`/skills/${id}?run=${r.ok ? (r.queued ? 'queued' : r.skipped) : r.code}`);
}

type SkillIssueView = { code: string; field?: string };
export type EditorResult =
  | { ok: true; document?: string; text?: string; id?: string; version?: number }
  | { ok: false; code: string; issues?: SkillIssueView[] };

const MAX_REQUEST = 2_000;

/**
 * Drafts and previews spend the workspace's own model budget: each reserves a slot first, at most
 * 20 per member and rolling hour, burst-safe (P4-R16, P4-R29). A refused slot costs nothing.
 */
async function overBuilderLimit(actor: Awaited<ReturnType<typeof requireActor>>) {
  return !(await reserveBuilderCall(services().db, actor, new Date()));
}

/**
 * The skill builder: the user's request → a draft SKILL.md. Nothing is saved: the draft lands in
 * the editor, where the user reads and edits the full text before saving it.
 */
export async function draftSkillAction(request: unknown): Promise<EditorResult> {
  const actor = await requireActor();
  const parsed = z.string().trim().min(1).max(MAX_REQUEST).safeParse(request);
  if (!parsed.success) return { ok: false, code: 'invalid_request' };
  if (await overBuilderLimit(actor)) return { ok: false, code: 'rate_limited' };
  const r = await draftSkill(skillRunDeps(), actor, parsed.data);
  return r.ok ? { ok: true, document: r.document } : { ok: false, code: r.code };
}

/**
 * Preview on real data: runs the document once, as the user, read-only (the same run a schedule
 * makes, without delivery). Metered like any reply; not counted against the daily run limit.
 */
export async function previewSkillAction(document: unknown): Promise<EditorResult> {
  const actor = await requireActor();
  // Not capped here: the parser reports a document that is too long as an issue.
  const input = z.string().safeParse(document);
  if (!input.success) return { ok: false, code: 'invalid_request' };
  const parsed = parseSkillDocument(input.data);
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
  id: uuid.optional(),
  document: z.string().max(30_000),
  channelId: uuid.nullable(),
  baseVersion: version.optional(),
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
  rawId: unknown,
  rawVersion: unknown,
  rawBaseVersion: unknown,
): Promise<void> {
  const actor = await requireActor();
  const parsedId = uuid.safeParse(rawId);
  if (!parsedId.success) return fail('/skills', 'not_found');
  const id = parsedId.data;
  const parsed = z.tuple([version, version]).safeParse([rawVersion, rawBaseVersion]);
  if (!parsed.success) return failSkill(id, 'invalid');
  const [restored, baseVersion] = parsed.data;
  const detail = await getSkill(services().db, actor, id);
  if (!detail) return failSkill(id, 'not_found');
  const document = await getSkillVersion(services().db, actor, id, restored);
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
