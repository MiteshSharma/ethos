import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../rpc';
import type { CatalogProviderId } from './providers';

// The onboarding model list is the server's catalog (packages/wiring
// MODEL_CATALOG via the models.catalog RPC) — there is no browser-side copy
// to drift from it. Same query key as the Personalities page so the two
// share one cache entry.
export type ModelCatalog = Awaited<ReturnType<typeof rpc.models.catalog>>;

export interface ModelCatalogEntry {
  providerId: CatalogProviderId;
  modelId: string;
  label: string;
  contextWindow: number;
  default?: boolean;
}

export function useModelCatalog() {
  return useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: () => rpc.models.catalog(),
  });
}

export function modelsForProvider(
  catalog: ModelCatalog | undefined,
  providerId: CatalogProviderId,
): ModelCatalogEntry[] {
  const models = catalog?.providers[providerId]?.models ?? [];
  return models.map((m) => ({
    providerId,
    modelId: m.id,
    label: m.label,
    contextWindow: m.contextWindow,
    ...(m.default ? { default: true } : {}),
  }));
}

/** Context window for a model id across every provider; undefined on a miss. */
export function lookupContextWindow(
  catalog: ModelCatalog | undefined,
  modelId: string,
): number | undefined {
  for (const provider of Object.values(catalog?.providers ?? {})) {
    const hit = provider.models.find((m) => m.id === modelId);
    if (hit) return hit.contextWindow;
  }
  return undefined;
}

export function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M ctx`;
  return `${Math.round(n / 1_000)}k ctx`;
}

export const LOW_CONTEXT_THRESHOLD = 64_000;
