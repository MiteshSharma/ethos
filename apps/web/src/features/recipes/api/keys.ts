export const recipeKeys = {
  all: () => ['recipes'] as const,
  list: () => [...recipeKeys.all(), 'list'] as const,
  get: (id: string) => [...recipeKeys.all(), 'get', id] as const,
  /**
   * Preflight is keyed on the answers it was computed for: it is stateless and
   * repeatable by design (§4), so every distinct set of answers is its own
   * cache entry and the "still needed from you" list shrinks as they fill in.
   * The credential bindings belong in the key for the same reason the inputs
   * do — the satisfied-check runs against them, so a different pick is a
   * different report.
   */
  preflight: (
    id: string,
    inputs: Record<string, string>,
    secretBindings: Record<string, { provider: string; secret: string }>,
  ) => [...recipeKeys.all(), 'preflight', id, inputs, secretBindings] as const,
};
