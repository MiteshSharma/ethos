import type { RecipeInstallMode, RecipeSecretBindings } from '@ethosagent/web-contracts';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { rpc } from '../../../rpc';
import { recipeKeys } from './keys';

// Recipes — plan/phases/recipes-gallery.md §4/§5.
//
// The catalog is curated, static and small, so `list` and `get` are cached
// hard. `preflight` is the opposite: read-only, stateless and re-called as the
// user types, because the "still needed from you" list shrinking live is the
// whole feel of the feature.

/** The catalog never changes without a server restart. */
const CATALOG_STALE_MS = 5 * 60_000;

/** Long enough that typing a city doesn't fire a request per keystroke. */
const PREFLIGHT_DEBOUNCE_MS = 250;

export function useRecipeList() {
  return useQuery({
    queryKey: recipeKeys.list(),
    queryFn: () => rpc.recipes.list(),
    staleTime: CATALOG_STALE_MS,
  });
}

export function useRecipe(id: string) {
  return useQuery({
    queryKey: recipeKeys.get(id),
    queryFn: () => rpc.recipes.get({ id }),
    staleTime: CATALOG_STALE_MS,
    enabled: id.length > 0,
  });
}

/**
 * Every bundle in the gallery, so a row can say whether its personality
 * already exists. `list` carries no install state on purpose (D8 — install
 * state is derived, never stored), and the personality id lives on the bundle.
 */
export function useRecipeBundles(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: recipeKeys.get(id),
      queryFn: () => rpc.recipes.get({ id }),
      staleTime: CATALOG_STALE_MS,
    })),
  });
}

/**
 * Stages 2 + 3. Debounced on `inputs` so a keystroke doesn't cost a round
 * trip, and `keepPreviousData` so the satisfied rows don't flash out and back
 * while the next report is in flight.
 */
export function useRecipePreflight(
  id: string,
  inputs: Record<string, string>,
  secretBindings: RecipeSecretBindings,
  options?: { enabled?: boolean; personalityIdOverride?: string; installMode?: RecipeInstallMode },
) {
  const debounced = useDebouncedValue(inputs, PREFLIGHT_DEBOUNCE_MS);
  const target = options?.personalityIdOverride;
  const mode = options?.installMode;
  // Not debounced: a binding, a target or a mode changes on a pick, not on a
  // keystroke, and its row should clear the instant it is chosen.
  return useQuery({
    queryKey: recipeKeys.preflight(id, debounced, secretBindings, target, mode),
    queryFn: () =>
      rpc.recipes.preflight({
        id,
        inputs: debounced,
        secretBindings,
        ...(target ? { personalityIdOverride: target } : {}),
        ...(mode ? { installMode: mode } : {}),
      }),
    placeholderData: keepPreviousData,
    enabled: (options?.enabled ?? true) && id.length > 0,
  });
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  // The object identity changes on every render; its CONTENT is what should
  // restart the timer.
  const serialized = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `serialized` is `value`'s identity
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [serialized, delayMs]);
  return debounced;
}
