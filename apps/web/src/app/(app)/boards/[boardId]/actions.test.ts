import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const actor = { orgId: 'org_1', userId: 'user_1', roles: ['member'] };
const db = { stub: true };
const requireActor = vi.fn(async () => actor);
vi.mock('@/server/context', () => ({
  requireActor: () => requireActor(),
  services: () => ({ db }),
}));

const updateWidget = vi.fn();
const removeWidget = vi.fn();
vi.mock('@agile/dashboards', async (importActual) => ({
  ...(await importActual<typeof import('@agile/dashboards')>()),
  updateWidget: (...a: unknown[]) => updateWidget(...a),
  removeWidget: (...a: unknown[]) => removeWidget(...a),
}));

const { removeWidgetAction, updateWidgetAction } = await import('./actions');

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

  it('asks for a session before anything else', async () => {
    requireActor.mockRejectedValueOnce(new Error('REDIRECT:/sign-in'));
    await expect(updateWidgetAction(BOARD, DASHBOARD, 'w-abc', { title: 'x' })).rejects.toThrow(
      'REDIRECT:/sign-in',
    );
    expect(updateWidget).not.toHaveBeenCalled();
  });
});

describe('removeWidgetAction', () => {
  beforeEach(() => {
    removeWidget.mockReset();
    revalidatePath.mockReset();
  });

  it("removes the actor's widget and refreshes the board", async () => {
    removeWidget.mockResolvedValue({ ok: true });
    await removeWidgetAction(BOARD, DASHBOARD, 'w-abc');
    expect(removeWidget).toHaveBeenCalledWith(db, actor, DASHBOARD, 'w-abc');
    expect(revalidatePath).toHaveBeenCalledWith(`/boards/${BOARD}`);
  });

  it('answers 404 for a bad board id', async () => {
    await expect(removeWidgetAction('nope', DASHBOARD, 'w-abc')).rejects.toThrow('NOT_FOUND');
    expect(removeWidget).not.toHaveBeenCalled();
  });

  it.each([
    ['a bad dashboard id', [BOARD, 'nope', 'w-abc']],
    ['a bad widget id', [BOARD, DASHBOARD, '../x']],
    ['a widget id that is not text', [BOARD, DASHBOARD, 42]],
  ])('reloads the board with not_found for %s', async (_name, args) => {
    const [b, d, w] = args as [string, string, string];
    await expect(removeWidgetAction(b, d, w)).rejects.toThrow(
      `REDIRECT:/boards/${BOARD}?error=not_found`,
    );
    expect(removeWidget).not.toHaveBeenCalled();
  });

  it("reloads the board with the store's refusal", async () => {
    removeWidget.mockResolvedValue({ ok: false, code: 'not_found' });
    await expect(removeWidgetAction(BOARD, DASHBOARD, 'w-abc')).rejects.toThrow(
      `REDIRECT:/boards/${BOARD}?error=not_found`,
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('asks for a session first', async () => {
    requireActor.mockRejectedValueOnce(new Error('REDIRECT:/sign-in'));
    await expect(removeWidgetAction(BOARD, DASHBOARD, 'w-abc')).rejects.toThrow(
      'REDIRECT:/sign-in',
    );
    expect(removeWidget).not.toHaveBeenCalled();
  });
});
