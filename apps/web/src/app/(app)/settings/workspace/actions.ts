'use server';

import { can } from '@agile/auth';
import { getWorkspaceSettings, SettingsError, updateWorkspaceSettings } from '@agile/privacy';
import { revalidatePath } from 'next/cache';
import { entitlements } from '@/server/billing';
import { requireActor, services } from '@/server/context';

export type SettingsState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string };

const int = (v: FormDataEntryValue | null) => (v === null || v === '' ? Number.NaN : Number(v));

/** Retention periods and external MCP access (owners and admins; bounds checked by the service). */
export async function saveWorkspaceSettingsAction(
  _prev: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const actor = await requireActor();
  const externalMcpEnabled = form.get('externalMcpEnabled') === 'on';
  try {
    // External MCP is a paid feature in SaaS: turning it on needs the plan (turning it off never).
    if (externalMcpEnabled && can(actor.roles, 'workspace.settings')) {
      const current = await getWorkspaceSettings(services().db, actor.orgId);
      if (!current.externalMcpEnabled && !(await entitlements(actor.orgId)).externalMcp) {
        return { status: 'error', code: 'plan_required' };
      }
    }
    await updateWorkspaceSettings(services().db, actor, {
      conversationRetentionDays: int(form.get('conversationRetentionDays')),
      usageRetentionDays: int(form.get('usageRetentionDays')),
      auditRetentionDays: int(form.get('auditRetentionDays')),
      externalMcpEnabled,
    });
  } catch (e) {
    if (e instanceof SettingsError) return { status: 'error', code: e.code };
    throw e;
  }
  revalidatePath('/settings/workspace');
  return { status: 'ok' };
}
