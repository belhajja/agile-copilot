import { can, workspaceName } from '@agile/auth';
import { getWorkspaceSettings, RETENTION_BOUNDS } from '@agile/privacy';
import { getTranslations } from 'next-intl/server';
import { entitlements } from '@/server/billing';
import { requireActor, services } from '@/server/context';
import { DeleteWorkspace } from './delete-workspace';
import { SettingsForm } from './settings-form';

/** Workspace-wide settings: data retention, external MCP access, deletion. */
export default async function WorkspaceSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations('workspace');
  const { db } = services();
  const [settings, name, plan] = await Promise.all([
    getWorkspaceSettings(db, actor.orgId),
    workspaceName(db, actor.orgId),
    entitlements(actor.orgId),
  ]);
  const canEdit = can(actor.roles, 'workspace.settings');
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{canEdit ? t('intro') : t('readOnlyNotice')}</p>
      </div>
      <SettingsForm
        settings={settings}
        bounds={RETENTION_BOUNDS}
        canEdit={canEdit}
        mcpInPlan={plan.externalMcp}
      />
      {can(actor.roles, 'workspace.delete') && name && (
        <DeleteWorkspace orgId={actor.orgId} name={name} />
      )}
    </div>
  );
}
