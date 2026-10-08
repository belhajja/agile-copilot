import { can } from '@agile/auth';
import { type Actor, type Db, orgSettings, recordAudit, withOrg } from '@agile/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export interface WorkspaceSettings {
  conversationRetentionDays: number;
  usageRetentionDays: number;
  auditRetentionDays: number;
  externalMcpEnabled: boolean;
}

/**
 * Defaults (a workspace without a settings row): conversations 180 days after their last message,
 * usage 2 years (a full budget year plus comparison), audit 1 year, external MCP off.
 */
export const DEFAULT_SETTINGS: WorkspaceSettings = {
  conversationRetentionDays: 180,
  usageRetentionDays: 730,
  auditRetentionDays: 365,
  externalMcpEnabled: false,
};

/**
 * Bounds: never "forever" (storage limitation), audit at least 90 days (also enforced in SQL).
 * Every minimum stays above the 24-hour window of the daily skill-run caps, which count
 * `skill_runs` (deleted on the conversation period).
 */
export const RETENTION_BOUNDS = {
  conversationRetentionDays: { min: 7, max: 3650 },
  usageRetentionDays: { min: 30, max: 3650 },
  auditRetentionDays: { min: 90, max: 3650 },
} as const;

const days = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

export const settingsPatchSchema = z
  .object({
    conversationRetentionDays: days(RETENTION_BOUNDS.conversationRetentionDays),
    usageRetentionDays: days(RETENTION_BOUNDS.usageRetentionDays),
    auditRetentionDays: days(RETENTION_BOUNDS.auditRetentionDays),
    externalMcpEnabled: z.boolean(),
  })
  .partial()
  .strict()
  // An empty patch changes nothing and would only write a meaningless audit entry.
  .refine((patch) => Object.keys(patch).length > 0);

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export class SettingsError extends Error {
  override name = 'SettingsError';
  constructor(readonly code: 'forbidden_role' | 'invalid_input') {
    super(code);
  }
}

const toSettings = (row: typeof orgSettings.$inferSelect): WorkspaceSettings => ({
  conversationRetentionDays: row.conversationRetentionDays,
  usageRetentionDays: row.usageRetentionDays,
  auditRetentionDays: row.auditRetentionDays,
  externalMcpEnabled: row.externalMcpEnabled,
});

export async function getWorkspaceSettings(db: Db, orgId: string): Promise<WorkspaceSettings> {
  const [row] = await withOrg(db, orgId, (tx) =>
    tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId)),
  );
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS };
}

/**
 * Owners and admins change settings; every change is audited with the old and new values. The
 * current values are read and locked in the write transaction (the row is created with the
 * defaults first), so concurrent saves never lose a change or audit a stale "from".
 */
export async function updateWorkspaceSettings(
  db: Db,
  actor: Actor,
  patch: unknown,
): Promise<WorkspaceSettings> {
  if (!can(actor.roles, 'workspace.settings')) throw new SettingsError('forbidden_role');
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw new SettingsError('invalid_input');
  return withOrg(db, actor.orgId, async (tx) => {
    await tx.insert(orgSettings).values({ orgId: actor.orgId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(orgSettings)
      .where(eq(orgSettings.orgId, actor.orgId))
      .for('update');
    const before = row ? toSettings(row) : { ...DEFAULT_SETTINGS };
    const after = { ...before, ...parsed.data };
    await tx
      .update(orgSettings)
      .set({ ...after, updatedBy: actor.userId })
      .where(eq(orgSettings.orgId, actor.orgId));
    const changed = Object.fromEntries(
      Object.entries(parsed.data).map(([k, v]) => [
        k,
        { from: before[k as keyof WorkspaceSettings], to: v },
      ]),
    );
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'workspace.settings_changed',
      targetType: 'organization',
      targetId: actor.orgId,
      metadata: changed,
    });
    return after;
  });
}
