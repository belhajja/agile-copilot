import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const actor = { orgId: 'org_1', userId: 'user_1', roles: ['member'] };
const db = { stub: true };
vi.mock('@/server/context', () => ({
  requireActor: async () => actor,
  services: () => ({ db }),
}));

const updateWidget = vi.fn();
vi.mock('@agile/dashboards', async (importActual) => ({
  ...(await importActual<typeof import('@agile/dashboards')>()),
  updateWidget: (...a: unknown[]) => updateWidget(...a),
}));

const { updateWidgetAction } = await import('./actions');

const BOARD = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
const DASHBOARD = '6a1e3c55-2b7d-4f0e-9c61-0d9f4b2a7e30';

describe('updateWidgetAction', () => {
  beforeEach(() => {
    updateWidget.mockReset();
    revalidatePath.mockReset();
  });

  it("updates the actor's widget and refreshes the board", async () => {
    updateWidget.mockResolvedValue({ ok: true, widget: {} });
    expect(
      await updateWidgetAction(BOARD, DASHBOARD, 'w-abc', { title: 'Mine', chart: 'kpi' }),
    ).toEqual({ ok: true });
    expect(updateWidget).toHaveBeenCalledWith(db, actor, DASHBOARD, 'w-abc', {
      title: 'Mine',
      chart: 'kpi',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/boards/${BOARD}`);
  });

  it('passes a null title through (back to the default)', async () => {
    updateWidget.mockResolvedValue({ ok: true, widget: {} });
    await updateWidgetAction(BOARD, DASHBOARD, 'w-abc', { title: null });
    expect(updateWidget).toHaveBeenCalledWith(db, actor, DASHBOARD, 'w-abc', { title: null });
  });

  it.each([
    ['a bad board id', ['nope', DASHBOARD, 'w-abc', { title: 'x' }]],
    ['a bad dashboard id', [BOARD, 'nope', 'w-abc', { title: 'x' }]],
    ['a bad widget id', [BOARD, DASHBOARD, '../x', { title: 'x' }]],
    ['an unknown chart', [BOARD, DASHBOARD, 'w-abc', { chart: 'radar' }]],
    ['an unknown field', [BOARD, DASHBOARD, 'w-abc', { params: {} }]],
    ['no change', [BOARD, DASHBOARD, 'w-abc', {}]],
    ['a title that is not text', [BOARD, DASHBOARD, 'w-abc', { title: 42 }]],
  ])('refuses %s without touching the store', async (_name, args) => {
    const [b, d, w, c] = args as [string, string, string, { title?: string }];
    expect(await updateWidgetAction(b, d, w, c)).toEqual({ ok: false, code: 'invalid_widget' });
    expect(updateWidget).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns the store's refusal, and a code (not the error) when it throws", async () => {
    updateWidget.mockResolvedValueOnce({ ok: false, code: 'not_found' });
    expect(await updateWidgetAction(BOARD, DASHBOARD, 'w-abc', { title: 'x' })).toEqual({
      ok: false,
      code: 'not_found',
    });
    updateWidget.mockRejectedValueOnce(new Error('connection refused: secret'));
    expect(await updateWidgetAction(BOARD, DASHBOARD, 'w-abc', { title: 'x' })).toEqual({
      ok: false,
      code: 'unknown',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
