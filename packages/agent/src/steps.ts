/** Model steps per chat reply (tool round-trips included). */
export const CHAT_MAX_STEPS = 12;

/**
 * `prepareStep` for a step-limited reply: the last allowed step offers no tools, so the model
 * has to answer with what it gathered instead of stopping on a tool call with nothing said.
 */
export function lastStepWithoutTools(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber >= maxSteps - 1 ? { activeTools: [], toolChoice: 'none' as const } : undefined;
}
