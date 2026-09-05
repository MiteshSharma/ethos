import { z } from 'zod';

export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
export const CODEX_DISCOVERY_TIMEOUT_MS = 10_000;
/** How long a discovery result is reused before the models endpoint is asked again. */
export const CODEX_DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1_000;

export const CODEX_FALLBACK_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
];

export interface ModelDiscovery {
  models: string[];
  /** `live` when the list came from the models endpoint; `fallback` when it is
   *  the static roster — a guess, never proof that a model is unavailable. */
  source: 'live' | 'fallback';
}

const FALLBACK_DISCOVERY: ModelDiscovery = { models: CODEX_FALLBACK_MODELS, source: 'fallback' };

const modelsResponseSchema = z.object({
  models: z.array(z.object({ id: z.string() })).min(1),
});

export async function discoverModels(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ModelDiscovery> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CODEX_DISCOVERY_TIMEOUT_MS);
    const res = await fetchFn(CODEX_MODELS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return FALLBACK_DISCOVERY;
    const parsed = modelsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return FALLBACK_DISCOVERY;
    return { models: parsed.data.models.map((m) => m.id), source: 'live' };
  } catch {
    return FALLBACK_DISCOVERY;
  }
}

// ---------------------------------------------------------------------------
// Process-wide cache — the provider checks its configured model on the first
// turn and the 400 path reads the roster back; neither should cost a round
// trip per turn.
// ---------------------------------------------------------------------------

let cached: { discovery: ModelDiscovery; fetchedAt: number } | null = null;

export async function discoverModelsCached(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<ModelDiscovery> {
  if (cached && now - cached.fetchedAt < CODEX_DISCOVERY_CACHE_TTL_MS) return cached.discovery;
  const discovery = await discoverModels(accessToken, fetchFn);
  cached = { discovery, fetchedAt: now };
  return discovery;
}

export function resetModelDiscoveryCache(): void {
  cached = null;
}

export function unsupportedModelMessage(model: string, supported: string[]): string {
  return `Codex: model "${model}" is not available to this ChatGPT account. Supported: ${supported.join(', ')} — set \`model:\` in ~/.ethos/config.yaml to one of these.`;
}

const errorBodySchema = z.object({ detail: z.string() });

/**
 * For a Codex Responses API 400 body: the supported-model hint when the
 * rejection is about the model, otherwise null. Reads the cached roster (or
 * the static fallback) — an error path must not add a network round trip.
 */
export function modelRejectionHint(body: string, model: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = errorBodySchema.safeParse(json);
  if (!parsed.success) return null;
  const detail = parsed.data.detail;
  if (!/\bmodel\b/i.test(detail) || !/not supported/i.test(detail)) return null;
  return unsupportedModelMessage(model, cached?.discovery.models ?? CODEX_FALLBACK_MODELS);
}
