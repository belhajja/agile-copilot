'use server';

import { requestSkillRun } from '@agile/automation';
import { isUuid } from '@agile/db';
import {
  copyBuiltinSkill,
  deleteSkill,
  forkSkill,
  type SkillLocale,
  setSkillEnabled,
  setSkillVisibility,
} from '@agile/skills';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { skillQueue, skillRunsDailyLimit } from '@/server/automation';
import { requireActor, services } from '@/server/context';

const locale = async (): Promise<SkillLocale> => ((await getLocale()) === 'fr' ? 'fr' : 'en');

/** No silent failures (P4-R11): a refused action comes back to the page with a translated code. */
const fail = (path: string, code: string): never =>
  redirect(`${path}?error=${encodeURIComponent(code)}`);

/** Copies a built-in skill into an editable one of the user's, and opens it. */
export async function copyBuiltinSkillAction(key: string): Promise<void> {
  const actor = await requireActor();
  const r = await copyBuiltinSkill(services().db, actor, key, new Date(), await locale());
  if (!r.ok) fail('/skills', r.code);
  else redirect(`/skills/${r.id}`);
}

/**
 * Copies a skill shared in the workspace into the user's own skills (disabled, P4-R8) and opens
 * the copy. Only the skill's own page offers it, where its full text is shown.
 */
export async function forkSkillAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await forkSkill(services().db, actor, id, new Date(), await locale());
  if (!r.ok) fail(`/skills/${id}`, r.code);
  else redirect(`/skills/${r.id}`);
}

export async function setSkillVisibilityAction(
  id: string,
  visibility: 'private' | 'workspace',
): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await setSkillVisibility(services().db, actor, id, visibility);
  if (!r.ok) return fail(`/skills/${id}`, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${id}`);
}

export async function setSkillEnabledAction(id: string, enabled: boolean): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await setSkillEnabled(services().db, actor, id, enabled, new Date());
  if (!r.ok) return fail(`/skills/${id}`, r.code);
  revalidatePath('/skills');
  revalidatePath(`/skills/${id}`);
}

export async function deleteSkillAction(id: string): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(id)) return fail('/skills', 'not_found');
  const r = await deleteSkill(services().db, actor, id);
  if (!r.ok) return fail(`/skills/${id}`, r.code);
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
