import { safeFetch } from '@ethosagent/safety-network';
import type { ModelCatalogManifest, ModelEntry, Storage } from '@ethosagent/types';
import { MODEL_CATALOG, type ModelCatalogEntry } from './model-catalog';

export interface LoadModelCatalogOptions {
  url: string;
  ttlMs: number;
  storage: Storage;
  cachePath: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Fetch manifest from URL with timeout + schema validation.
 * Throws on network error, non-200, or invalid shape.
 */
export async function fetchManifest(url: string): Promise<ModelCatalogManifest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const result = await safeFetch(url, { policy: {}, init: { signal: controller.signal } });
    if (!result.ok) throw new Error(`model catalog fetch blocked: ${result.reason}`);
    const res = result.response;
    if (!res.ok) throw new Error(`model catalog fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!isValidManifest(json)) throw new Error('model catalog: invalid manifest shape');
    return json as ModelCatalogManifest;
  } finally {
    clearTimeout(timeout);
  }
}

function isValidManifest(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const m = obj as Record<string, unknown>;
  if (typeof m.version !== 'number') return false;
  if (typeof m.updatedAt !== 'string') return false;
  if (typeof m.providers !== 'object' || m.providers === null) return false;
  for (const [, provider] of Object.entries(m.providers as Record<string, unknown>)) {
    if (typeof provider !== 'object' || provider === null) return false;
    const p = provider as Record<string, unknown>;
    if (!Array.isArray(p.models)) return false;
    for (const model of p.models) {
      if (typeof model !== 'object' || model === null) return false;
      const entry = model as Record<string, unknown>;
      if (typeof entry.id !== 'string') return false;
      if (typeof entry.label !== 'string') return false;
      if (
        typeof entry.contextWindow !== 'number' ||
        !Number.isFinite(entry.contextWindow) ||
        entry.contextWindow <= 0
      )
        return false;
      if (entry.default !== undefined && typeof entry.default !== 'boolean') return false;
      if (entry.profile !== undefined && !isValidProfile(entry.profile)) return false;
    }
  }
  return true;
}

/**
 * Structurally validate an optional per-model `profile` (§7). Rejects a
 * malformed profile (non-numeric sampling, bad toolCallFormat, non-numeric
 * maxOutputTokens, out-of-range compaction/charsPerToken) but treats an absent
 * profile as valid — old manifests without a profile still load. Unknown keys
 * are tolerated (dropped at construction), matching the loader's
 * forward-compatibility posture.
 */
function isValidProfile(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const p = obj as Record<string, unknown>;
  if (p.sampling !== undefined) {
    if (typeof p.sampling !== 'object' || p.sampling === null) return false;
    const s = p.sampling as Record<string, unknown>;
    for (const key of ['temperature', 'topP', 'topK', 'minP']) {
      const v = s[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return false;
    }
  }
  if (
    p.toolCallFormat !== undefined &&
    p.toolCallFormat !== 'openai' &&
    p.toolCallFormat !== 'text-xml'
  )
    return false;
  if (
    p.maxOutputTokens !== undefined &&
    (typeof p.maxOutputTokens !== 'number' || !Number.isFinite(p.maxOutputTokens))
  )
    return false;
  if (p.structuredOutput !== undefined && typeof p.structuredOutput !== 'boolean') return false;
  if (p.parseThinkTags !== undefined && typeof p.parseThinkTags !== 'boolean') return false;
  // §5 — compaction thresholds are fractions in (0,1]; charsPerToken is a
  // positive divisor. Malformed values reject the whole profile; absent is fine.
  if (p.compaction !== undefined) {
    if (typeof p.compaction !== 'object' || p.compaction === null) return false;
    const c = p.compaction as Record<string, unknown>;
    for (const key of ['pressure', 'target']) {
      const v = c[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1))
        return false;
    }
  }
  if (
    p.charsPerToken !== undefined &&
    (typeof p.charsPerToken !== 'number' ||
      !Number.isFinite(p.charsPerToken) ||
      p.charsPerToken <= 0)
  )
    return false;
  // §2 — prompt-budget knobs. Booleans + a positive char cap. Malformed values
  // reject the whole profile; absent is fine (assembly unchanged).
  if (p.promptBudget !== undefined) {
    if (typeof p.promptBudget !== 'object' || p.promptBudget === null) return false;
    const pb = p.promptBudget as Record<string, unknown>;
    if (pb.compactPrelude !== undefined && typeof pb.compactPrelude !== 'boolean') return false;
    if (pb.suppressMemoryGuidance !== undefined && typeof pb.suppressMemoryGuidance !== 'boolean')
      return false;
    if (
      pb.memorySnapshotCap !== undefined &&
      (typeof pb.memorySnapshotCap !== 'number' ||
        !Number.isFinite(pb.memorySnapshotCap) ||
        pb.memorySnapshotCap <= 0)
    )
      return false;
  }
  return true;
}

/**
 * Read cached manifest from Storage. Returns null if missing or unparseable.
 */
export async function loadCachedManifest(
  storage: Storage,
  cachePath: string,
): Promise<{ manifest: ModelCatalogManifest; ageMs: number } | null> {
  const content = await storage.read(cachePath);
  if (!content) return null;
  try {
    const manifest = JSON.parse(content);
    if (!isValidManifest(manifest)) return null;
    const mtime = await storage.mtime(cachePath);
    const ageMs = mtime ? Date.now() - mtime : Infinity;
    return { manifest: manifest as ModelCatalogManifest, ageMs };
  } catch {
    return null;
  }
}

/**
 * Write manifest to cache atomically via Storage.
 */
export async function writeCachedManifest(
  storage: Storage,
  cachePath: string,
  manifest: ModelCatalogManifest,
): Promise<void> {
  const dir = cachePath.substring(0, cachePath.lastIndexOf('/'));
  await storage.mkdir(dir);
  await storage.writeAtomic(cachePath, JSON.stringify(manifest, null, 2));
}

/**
 * Convert the bundled MODEL_CATALOG array to the manifest shape.
 */
export function bundledToManifest(): ModelCatalogManifest {
  const providers: Record<string, { models: ModelEntry[] }> = {};
  for (const entry of MODEL_CATALOG) {
    // Lane 0 — local providers (ollama, vllm) keep their own manifest key.
    // Collapsing them into 'openai-compat' erased them on the way back out:
    // manifestToEntries maps 'openai-compat' → 'openai', so the bundled Ollama
    // rows resurfaced as providerId 'openai' and were unreachable as Ollama
    // rows. Hosted openai-compatible providers still collapse (unchanged).
    const key =
      entry.providerId === 'anthropic'
        ? 'anthropic'
        : entry.providerId === 'azure'
          ? 'azure'
          : entry.providerId === 'ollama' || entry.providerId === 'vllm'
            ? entry.providerId
            : 'openai-compat';
    if (!providers[key]) providers[key] = { models: [] };
    const model: ModelEntry = {
      id: entry.modelId,
      label: entry.label,
      contextWindow: entry.contextWindow,
    };
    if (entry.default) model.default = true;
    if (entry.profile) model.profile = entry.profile;
    providers[key].models.push(model);
  }
  return { version: 1, updatedAt: new Date().toISOString(), providers };
}

/**
 * Merge remote manifest into bundled, ensuring bundled-only providers persist.
 */
export function mergeRemoteIntoBundled(
  remote: ModelCatalogManifest,
  bundled: ModelCatalogManifest,
): ModelCatalogManifest {
  const merged = { ...remote, providers: { ...remote.providers } };
  for (const [key, catalog] of Object.entries(bundled.providers)) {
    if (!merged.providers[key]) {
      merged.providers[key] = catalog;
    }
  }
  return merged;
}

/**
 * Main loader: remote → cache → bundled fallback.
 */
export async function loadModelCatalog(
  opts: LoadModelCatalogOptions,
): Promise<ModelCatalogManifest> {
  const { url, ttlMs, storage, cachePath, logger } = opts;
  const bundled = bundledToManifest();

  // 1. Try cache first — if fresh, skip network
  const cached = await loadCachedManifest(storage, cachePath);
  if (cached && cached.ageMs < ttlMs) {
    return mergeRemoteIntoBundled(cached.manifest, bundled);
  }

  // 2. Fetch remote
  try {
    const remote = await fetchManifest(url);
    // Cache the fresh manifest
    await writeCachedManifest(storage, cachePath, remote).catch(() => {});
    logger?.info(
      `model catalog: loaded ${Object.values(remote.providers).reduce((sum, p) => sum + p.models.length, 0)} entries from remote (manifest v${remote.version}, updated ${remote.updatedAt})`,
    );
    return mergeRemoteIntoBundled(remote, bundled);
  } catch {
    // 3. Fallback: stale cache or bundled
    if (cached) {
      const hours = Math.round(cached.ageMs / 3_600_000);
      logger?.warn(`model catalog fetch failed; using cache (${hours}h old)`);
      return mergeRemoteIntoBundled(cached.manifest, bundled);
    }
    logger?.warn('model catalog fetch failed; using bundled snapshot');
    return bundled;
  }
}

/**
 * Convert a ModelCatalogManifest back to the flat ModelCatalogEntry[] format
 * expected by createPersonalityDesignTools and other consumers.
 */
export function manifestToEntries(manifest: ModelCatalogManifest): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  const providerMapping: Record<string, string> = {
    anthropic: 'anthropic',
    azure: 'azure',
    'openai-compat': 'openai',
    // Lane 0 — explicit inverses of bundledToManifest's local-provider keys.
    // The `?? providerId` fall-through below would cover these identically;
    // they are listed so the round-trip contract is visible in one place.
    ollama: 'ollama',
    vllm: 'vllm',
  };
  for (const [providerId, catalog] of Object.entries(manifest.providers)) {
    const mappedId = providerMapping[providerId] ?? providerId;
    for (const model of catalog.models) {
      const entry: ModelCatalogEntry = {
        providerId: mappedId,
        modelId: model.id,
        label: model.label,
        contextWindow: model.contextWindow,
      };
      if (model.default) entry.default = true;
      if (model.profile) entry.profile = model.profile;
      entries.push(entry);
    }
  }
  return entries;
}
