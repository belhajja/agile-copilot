import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = { stub: true };
let actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };

const privacy = vi.hoisted(() => ({
  getWorkspaceSettings: vi.fn(),
  updateWorkspaceSettings: vi.fn(),
}));
const entitlements = vi.hoisted(() => vi.fn());
const requireActor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@agile/privacy', async (importActual) => ({
  SettingsError: (await importActual<typeof import('@agile/privacy')>()).SettingsError,
  ...privacy,
}));
vi.mock('@/server/billing', () => ({ entitlements }));
vi.mock('@/server/context', () => ({ requireActor, services: () => ({ db }) }));

const { SettingsError } = await import('@agile/privacy');
const { saveWorkspaceSettingsAction } = await import('./actions');
const idle = { status: 'idle' } as const;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const retention = {
  conversationRetentionDays: '90',
  usageRetentionDays: '365',
  auditRetentionDays: '400',
};

describe('saveWorkspaceSettingsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actor = { orgId: 'org_1', userId: 'user_1', roles: ['owner'] };
    requireActor.mockImplementation(async () => actor);
    privacy.getWorkspaceSettings.mockResolvedValue({ externalMcpEnabled: false });
    entitlements.mockResolvedValue({ externalMcp: true });
  });

  it('saves the periods and the MCP switch', async () => {
    expect(
      await saveWorkspaceSettingsAction(idle, form({ ...retention, externalMcpEnabled: 'on' })),
    ).toEqual({ status: 'ok' });
    expect(privacy.updateWorkspaceSettings).toHaveBeenCalledWith(db, actor, {
      conversationRetentionDays: 90,
      usageRetentionDays: 365,
      auditRetentionDays: 400,
      externalMcpEnabled: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/workspace');
  });

  it('needs the plan to turn external MCP on', async () => {
    entitlements.mockResolvedValue({ externalMcp: false });
    expect(
      await saveWorkspaceSettingsAction(idle, form({ ...retention, externalMcpEnabled: 'on' })),
    ).toEqual({ status: 'error', code: 'plan_required' });
    expect(privacy.updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("returns the service's refusal (role, bounds) as a code", async () => {
    actor = { ...actor, roles: ['viewer'] };
    privacy.updateWorkspaceSettings.mockRejectedValue(new SettingsError('forbidden_role'));
    expect(await saveWorkspaceSettingsAction(idle, form(retention))).toEqual({
      status: 'error',
      code: 'forbidden_role',
    });
  });

  it.each([retention, 'conversationRetentionDays=1', null])(
    'refuses the non-form %j',
    async (input) => {
      expect(await saveWorkspaceSettingsAction(idle, input)).toEqual({
        status: 'error',
        code: 'invalid_input',
      });
      expect(privacy.updateWorkspaceSettings).not.toHaveBeenCalled();
    },
  );

  it('asks for a session before anything else', async () => {
    requireActor.mockRejectedValue(new Error('REDIRECT:/login'));
    await expect(saveWorkspaceSettingsAction(idle, form(retention))).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(privacy.updateWorkspaceSettings).not.toHaveBeenCalled();
  });
});
