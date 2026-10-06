/** The select option that switches the model field back to free text. Never a real model id. */
export const OTHER_MODEL = '__other__';

/**
 * Whether a loaded list is worth showing as a dropdown. An empty list always falls back to free
 * text: a <select> with only "Other…" would have the browser auto-select that single option,
 * silently submitting the sentinel as the model.
 */
export function canShowModelList(models: string[]): boolean {
  return models.length > 0;
}

/** The dropdown's initial value: `current` when the list still offers it, else the first model. */
export function initialSelection(models: string[], current: string): string {
  return models.includes(current) ? current : (models[0] ?? current);
}

export interface ModelsLoadFailure {
  code: string;
  reason?: string;
  host?: string;
}

export interface PickingState {
  models: string[];
  selected: string;
  other: boolean;
  error?: ModelsLoadFailure;
}

export type ModelsLoadResult =
  | { ok: true; models: string[] }
  | { ok: false; code: string; reason?: string; host?: string };

/**
 * The "Change model" picker's state after a load attempt. A failure never leaves the user stuck:
 * it still offers free text to type a model and save, alongside the error to show.
 */
export function pickingStateFromLoad(result: ModelsLoadResult, current: string): PickingState {
  if (!result.ok) {
    return {
      models: [],
      selected: current,
      other: true,
      error: { code: result.code, reason: result.reason, host: result.host },
    };
  }
  return {
    models: result.models,
    selected: initialSelection(result.models, current),
    other: !canShowModelList(result.models),
  };
}
