// ---------------------------------------------------------------------------
// Local OpenAI-compatible model discovery + served-context-window probe
//
// Shared by both setup paths — the readline fallback (apps/ethos) and the Ink
// TUI wizard (apps/tui) — so the `GET /v1/models` protocol lives in exactly one
// place. Local providers (ollama, vllm) serve their model list here; setup
// offers it as a pick-list and falls back to free-text entry when unreachable.
//
// Lane 0 ("Truth about the window") extends this from an id list into a
// per-runtime capability probe: the served context window is read from the
// server that knows it (vLLM `max_model_len`, llama.cpp `n_ctx`, LM Studio
// per-model metadata, Ollama `/api/ps` for the LOADED model).
//
// CONTEXT-WINDOW RESOLUTION PRECEDENCE (eng review D15 — do not invert):
//
//   config > probe > catalog > default
//
// Operator authority (`contextWindow` in ~/.ethos/config.yaml) outranks the
// probe — on Ollama the probe is the least trustworthy input. A successful
// probe that disagrees with explicit config draws a warning diagnostic, but
// the config value wins. The catalog is a fallback of ADVERTISED architecture
// windows (capped for local runtimes, see ARCH_WINDOW_CAP_TOKENS); the
// default (no resolution at all) is a guess and is surfaced loudly on local
// dialects instead of silently assumed.
//
// All probes keep the existing fail-soft posture: a bounded timeout
// (2,500 ms), structural parsing with no wholesale casts, and any
// unrecognized shape resolves to "unknown window" — never a guess.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';

/** Extract model ids from an OpenAI-compatible `GET /v1/models` body.
 *  Shape: `{ data: [{ id: string }, ...] }`. Structural guard only — anything
 *  that doesn't match yields an empty list (no `as` casts). */
export function parseOpenAiModelsResponse(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

export interface LocalModelsResult {
  /** Whether the endpoint answered a well-formed model list in time. */
  reachable: boolean;
  models: string[];
}

/** Fetch the served model list from a local OpenAI-compatible endpoint.
 *  Times out fast so setup never hangs on an unreachable endpoint; any
 *  failure (network error, timeout, non-2xx, malformed body) reports
 *  `reachable: false` so the caller falls back to a free-text model prompt. */
export async function fetchLocalModels(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LocalModelsResult> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, models: [] };
    const body: unknown = await res.json();
    const models = parseOpenAiModelsResponse(body);
    if (models.length === 0) return { reachable: false, models: [] };
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

// ---------------------------------------------------------------------------
// Lane 0 — served-context-window probe
// ---------------------------------------------------------------------------

/** Local runtimes the window probe knows how to interrogate. */
export type LocalRuntime = 'ollama' | 'vllm' | 'llamacpp' | 'lmstudio';

/** Default probe timeout — matches the existing `fetchLocalModels` posture. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * Detect which local runtime a `(providerName, baseUrl)` pair points at.
 * Name-based first (the configured alias is authoritative), then default-port
 * heuristics for endpoints configured under a generic alias. Returns
 * `undefined` for anything unrecognized — hosted endpoints are never probed.
 * A wrong port heuristic fails soft: probing an unknown server 404s and the
 * probe reports "unknown window", never a wrong one.
 */
export function detectLocalRuntime(
  providerName: string,
  baseUrl: string,
): LocalRuntime | undefined {
  const n = providerName.toLowerCase();
  if (n === 'ollama') return 'ollama';
  if (n === 'vllm') return 'vllm';
  if (n === 'llamacpp' || n === 'llama.cpp' || n === 'llama-cpp') return 'llamacpp';
  if (n === 'lmstudio' || n === 'lm-studio') return 'lmstudio';
  if (baseUrl.includes(':11434')) return 'ollama'; // Ollama default port
  if (baseUrl.includes(':1234')) return 'lmstudio'; // LM Studio default port
  if (baseUrl.includes(':8080')) return 'llamacpp'; // llama.cpp server default port
  return undefined;
}

export interface WindowProbeResult {
  /** Whether the endpoint answered the probe at all. */
  reachable: boolean;
  /** Served context window in tokens. Undefined → the window is UNKNOWN. */
  contextWindow?: number;
  /**
   * How trustworthy the number is:
   *  - 'allocation' — backed by a real server allocation (vLLM `max_model_len`,
   *    llama.cpp `n_ctx`, Ollama `/api/ps` context of the LOADED model,
   *    LM Studio `loaded_context_length`). True by construction; never capped.
   *  - 'architecture' — the model's architecture maximum, an UPPER BOUND on
   *    the served window (LM Studio `max_context_length`). Subject to
   *    ARCH_WINDOW_CAP_TOKENS at resolution.
   */
  source?: 'allocation' | 'architecture';
  /** Actionable diagnostic when the window could not be resolved. */
  diagnostic?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function finitePositive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** Root URL for runtimes whose native API lives beside `/v1` (Ollama `/api/*`,
 *  llama.cpp `/props`). */
function stripV1(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
}

/** Ollama tags are optional in config ("llama3.2" vs served "llama3.2:latest") —
 *  match exact first, then tag-stripped both ways. */
function ollamaNameMatches(served: string, wanted: string): boolean {
  if (served === wanted) return true;
  const strippedServed = served.split(':')[0] ?? served;
  const strippedWanted = wanted.split(':')[0] ?? wanted;
  return (
    strippedServed === wanted || served === strippedWanted || strippedServed === strippedWanted
  );
}

/**
 * Parse Ollama `GET /api/ps` — the ONLY place the SERVED window of a model is
 * observable (eng review D14). Shape: `{ models: [{ name, model,
 * context_length }] }`. `context_length` here is the window the running model
 * was loaded with (num_ctx), i.e. allocation-backed. A model that is not in
 * the list is not loaded, and its served window is UNKNOWN.
 */
export function parseOllamaPs(
  body: unknown,
  model: string,
): { loaded: boolean; contextWindow?: number } {
  const rec = asRecord(body);
  const models = rec?.models;
  if (!Array.isArray(models)) return { loaded: false };
  for (const entry of models) {
    const e = asRecord(entry);
    if (!e) continue;
    const name = typeof e.name === 'string' ? e.name : undefined;
    const modelField = typeof e.model === 'string' ? e.model : undefined;
    const matches =
      (name !== undefined && ollamaNameMatches(name, model)) ||
      (modelField !== undefined && ollamaNameMatches(modelField, model));
    if (!matches) continue;
    const window = finitePositive(e.context_length);
    return window !== undefined ? { loaded: true, contextWindow: window } : { loaded: true };
  }
  return { loaded: false };
}

/**
 * Parse vLLM `GET /v1/models` — each entry carries `max_model_len`, the
 * `--max-model-len` the server was LAUNCHED with. Allocation-backed truth.
 */
export function parseVllmMaxModelLen(body: unknown, model: string): number | undefined {
  const rec = asRecord(body);
  const data = rec?.data;
  if (!Array.isArray(data)) return undefined;
  for (const entry of data) {
    const e = asRecord(entry);
    if (!e) continue;
    if (e.id !== model) continue;
    return finitePositive(e.max_model_len);
  }
  return undefined;
}

/**
 * Parse llama.cpp `GET /props` — `default_generation_settings.n_ctx` (older
 * builds expose a top-level `n_ctx`). The context the server ALLOCATED at
 * launch (`-c` / `--ctx-size`). Allocation-backed truth.
 */
export function parseLlamaCppProps(body: unknown): number | undefined {
  const rec = asRecord(body);
  if (!rec) return undefined;
  const settings = asRecord(rec.default_generation_settings);
  return finitePositive(settings?.n_ctx) ?? finitePositive(rec.n_ctx);
}

/**
 * Parse LM Studio `GET /v1/models` per-model metadata. LM Studio reports
 * `loaded_context_length` (the window the model is loaded with — allocation)
 * and `max_context_length` (the architecture maximum — upper bound only).
 */
export function parseLmStudioModels(
  body: unknown,
  model: string,
): { contextWindow: number; source: 'allocation' | 'architecture' } | undefined {
  const rec = asRecord(body);
  const data = rec?.data;
  if (!Array.isArray(data)) return undefined;
  for (const entry of data) {
    const e = asRecord(entry);
    if (!e || e.id !== model) continue;
    const loaded = finitePositive(e.loaded_context_length);
    if (loaded !== undefined) return { contextWindow: loaded, source: 'allocation' };
    const max = finitePositive(e.max_context_length);
    if (max !== undefined) return { contextWindow: max, source: 'architecture' };
    return undefined;
  }
  return undefined;
}

export interface ProbeServedWindowOptions {
  runtime: LocalRuntime;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Probe a local runtime for the SERVED context window of `model`. Fail-soft:
 * network errors, timeouts, non-2xx, and unrecognized body shapes all resolve
 * to "unknown window" with a diagnostic — the probe never throws and never
 * blocks the caller beyond the bounded timeout.
 *
 * NOTE on Ollama (eng review D14): `POST /api/show`'s `context_length` is the
 * ARCHITECTURE maximum, not the served `num_ctx` — reporting it as the window
 * would reproduce the advertised-vs-served lie with a probe's authority
 * behind it. This probe deliberately does not consult `/api/show` at all:
 * model not loaded → the window is explicitly UNKNOWN.
 */
export async function probeServedWindow(
  opts: ProbeServedWindowOptions,
): Promise<WindowProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { runtime, baseUrl, model } = opts;
  try {
    if (runtime === 'ollama') {
      const res = await fetchImpl(`${stripV1(baseUrl)}/api/ps`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return {
          reachable: false,
          diagnostic: `window probe for '${model}' at ${baseUrl} failed: HTTP ${res.status}`,
        };
      }
      const ps = parseOllamaPs(await res.json(), model);
      if (ps.loaded && ps.contextWindow !== undefined) {
        return { reachable: true, contextWindow: ps.contextWindow, source: 'allocation' };
      }
      if (ps.loaded) {
        return {
          reachable: true,
          diagnostic:
            `ollama reports '${model}' loaded but not its context length — served window unknown. ` +
            `Set OLLAMA_CONTEXT_LENGTH (or Modelfile num_ctx) explicitly, or set 'contextWindow' in ~/.ethos/config.yaml.`,
        };
      }
      return {
        reachable: true,
        diagnostic:
          `ollama model '${model}' is not loaded — served context window unknown ` +
          `(only /api/ps reports the served num_ctx; /api/show advertises the architecture max). ` +
          `Load it (e.g. 'ollama run ${model}') and set OLLAMA_CONTEXT_LENGTH to size its window, ` +
          `or set 'contextWindow' in ~/.ethos/config.yaml.`,
      };
    }
    if (runtime === 'vllm') {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return {
          reachable: false,
          diagnostic: `window probe for '${model}' at ${baseUrl} failed: HTTP ${res.status}`,
        };
      }
      const window = parseVllmMaxModelLen(await res.json(), model);
      return window !== undefined
        ? { reachable: true, contextWindow: window, source: 'allocation' }
        : {
            reachable: true,
            diagnostic: `vLLM at ${baseUrl} does not report max_model_len for '${model}' — served window unknown.`,
          };
    }
    if (runtime === 'llamacpp') {
      const res = await fetchImpl(`${stripV1(baseUrl)}/props`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return {
          reachable: false,
          diagnostic: `window probe for '${model}' at ${baseUrl} failed: HTTP ${res.status}`,
        };
      }
      const window = parseLlamaCppProps(await res.json());
      return window !== undefined
        ? { reachable: true, contextWindow: window, source: 'allocation' }
        : {
            reachable: true,
            diagnostic: `llama.cpp at ${baseUrl} does not report n_ctx — served window unknown.`,
          };
    }
    // lmstudio
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        reachable: false,
        diagnostic: `window probe for '${model}' at ${baseUrl} failed: HTTP ${res.status}`,
      };
    }
    const meta = parseLmStudioModels(await res.json(), model);
    return meta !== undefined
      ? { reachable: true, contextWindow: meta.contextWindow, source: meta.source }
      : {
          reachable: true,
          diagnostic: `LM Studio at ${baseUrl} reports no context metadata for '${model}' — served window unknown.`,
        };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      diagnostic: `window probe for '${model}' at ${baseUrl} failed: ${reason}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Lane 0 — probe result disk cache (eng review D3+D16)
// ---------------------------------------------------------------------------

/** Short TTL: chat/gateway startup rides the cache; the tuning-loop command
 *  paths (setup / doctor / personality show / bench context) force a live
 *  probe and rewrite it, so stale numbers never survive an operator's edit. */
export const WINDOW_PROBE_TTL_MS = 15 * 60_000;

/** Canonical cache location under the data dir (~/.ethos). */
export function windowProbeCachePath(dataDir: string): string {
  return join(dataDir, 'cache', 'window-probe.json');
}

interface WindowProbeCacheEntry {
  contextWindow: number;
  source: 'allocation' | 'architecture';
  probedAt: number;
}

/** Structural parse of the cache file. Returns null on ANY malformed content —
 *  the caller falls back to a live probe and rewrites the file (self-heal). */
function parseWindowProbeCache(content: string): Record<string, WindowProbeCacheEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (rec?.version !== 1) return null;
  const entries = asRecord(rec.entries);
  if (!entries) return null;
  const out: Record<string, WindowProbeCacheEntry> = {};
  for (const [key, value] of Object.entries(entries)) {
    const e = asRecord(value);
    if (!e) return null;
    const contextWindow = finitePositive(e.contextWindow);
    const probedAt =
      typeof e.probedAt === 'number' && Number.isFinite(e.probedAt) ? e.probedAt : undefined;
    const source = e.source === 'allocation' || e.source === 'architecture' ? e.source : undefined;
    if (contextWindow === undefined || probedAt === undefined || source === undefined) return null;
    out[key] = { contextWindow, source, probedAt };
  }
  return out;
}

export interface ProbeServedWindowCachedOptions extends ProbeServedWindowOptions {
  storage: Storage;
  cachePath: string;
  ttlMs?: number;
  /** Bypass the cache, probe live, and rewrite it (setup / doctor /
   *  personality show / bench context — eng review D16). */
  forceRefresh?: boolean;
  /** Test seam. */
  now?: () => number;
}

/**
 * Cache-first window probe. Keyed by `(baseUrl, model)`. A fresh cache hit is
 * ZERO network calls; a miss (or `forceRefresh`) runs one live probe and
 * rewrites the cache atomically on success. Corrupted cache content fails the
 * structural parse and self-heals via live probe + rewrite. Failed probes are
 * never cached — a server that just came up is retried on the next startup.
 */
export async function probeServedWindowCached(
  opts: ProbeServedWindowCachedOptions,
): Promise<WindowProbeResult> {
  const ttlMs = opts.ttlMs ?? WINDOW_PROBE_TTL_MS;
  const now = opts.now ?? Date.now;
  const cacheKey = `${opts.baseUrl}::${opts.model}`;

  let cached: Record<string, WindowProbeCacheEntry> | null = null;
  try {
    const content = await opts.storage.read(opts.cachePath);
    cached = content !== null ? parseWindowProbeCache(content) : null;
  } catch {
    cached = null;
  }

  if (!opts.forceRefresh) {
    const hit = cached?.[cacheKey];
    if (hit && now() - hit.probedAt < ttlMs) {
      return { reachable: true, contextWindow: hit.contextWindow, source: hit.source };
    }
  }

  const live = await probeServedWindow(opts);
  if (live.contextWindow !== undefined && live.source !== undefined) {
    const entries = { ...(cached ?? {}) };
    entries[cacheKey] = {
      contextWindow: live.contextWindow,
      source: live.source,
      probedAt: now(),
    };
    try {
      const dir = opts.cachePath.substring(0, opts.cachePath.lastIndexOf('/'));
      await opts.storage.mkdir(dir);
      await opts.storage.writeAtomic(
        opts.cachePath,
        JSON.stringify({ version: 1, entries }, null, 2),
      );
    } catch {
      // Cache write failure never blocks resolution — next startup probes again.
    }
  }
  return live;
}

// ---------------------------------------------------------------------------
// Lane 0 — resolution precedence (eng review D15)
// ---------------------------------------------------------------------------

/**
 * Cap for ARCHITECTURE-DERIVED windows on local runtimes (OpenClaw-derived
 * heuristic). Why: a 4B model advertising 262,144 tokens caused Ollama to
 * allocate a 12 GB KV cache and crawl at ~20 tok/s — the advertised window is
 * a claim about the architecture; the USABLE window is a claim about the GPU.
 * Capping at 32k costs nothing on a small model and prevents the pathological
 * allocation.
 *
 * Scope is precise (eng review D15): the cap applies ONLY to
 * architecture-derived values (catalog advertised windows, LM Studio
 * `max_context_length`, any Ollama `/api/show`-style upper bound) — NEVER to
 * allocation-backed probe values (vLLM `max_model_len`, llama.cpp `n_ctx` —
 * those were allocated at server launch and are true) and NEVER to explicit
 * config (operator authority; absurd values draw a sanity WARNING, not a
 * clamp).
 *
 * This number deliberately lands next to SMALL_WINDOW_MAX_TOKENS = 32_000
 * (model-catalog.ts): both encode "beyond ~32k a local window stops being a
 * free lunch". The agreement is intentional, not a duplicated magic number —
 * keep them adjacent if either ever moves.
 */
export const ARCH_WINDOW_CAP_TOKENS = 32_768;

export interface ResolveContextWindowOptions {
  provider: string;
  model: string;
  /** Operator override from ~/.ethos/config.yaml (`contextWindow`). */
  configWindow?: number;
  /** Live/cached probe result, when a local runtime was detected. */
  probe?: WindowProbeResult;
  /** Catalog advertised window (architecture-derived). */
  catalogWindow?: number;
  /** True when the endpoint is a detected local runtime — gates the
   *  architecture cap and the unknown-window diagnostic. */
  localRuntime: boolean;
}

export interface ResolvedContextWindow {
  /** Resolved window in tokens; undefined → nothing resolved (provider
   *  default applies downstream). */
  contextWindow?: number;
  source: 'config' | 'probe' | 'catalog' | 'default';
  /** True when ARCH_WINDOW_CAP_TOKENS clamped an architecture-derived value. */
  capped: boolean;
  /** Warnings for the caller to log — never thrown (warn-first release). */
  diagnostics: string[];
}

/**
 * Resolve the effective context window. Precedence: config > probe > catalog
 * > default (eng review D15 — see the module header for why the order is what
 * it is). Emits a warning diagnostic when explicit config and a successful
 * probe disagree.
 */
export function resolveContextWindow(opts: ResolveContextWindowOptions): ResolvedContextWindow {
  const { provider, model, configWindow, probe, catalogWindow, localRuntime } = opts;
  const diagnostics: string[] = [];
  const probedWindow = probe?.contextWindow;

  if (configWindow !== undefined) {
    if (probedWindow !== undefined && probedWindow !== configWindow) {
      diagnostics.push(
        `contextWindow ${configWindow} (config) disagrees with the probed served window ` +
          `${probedWindow} for ${model} on ${provider} — the config value wins; remove ` +
          `'contextWindow' from ~/.ethos/config.yaml to trust the probe.`,
      );
    }
    if (localRuntime && configWindow > ARCH_WINDOW_CAP_TOKENS) {
      diagnostics.push(
        `contextWindow ${configWindow} for ${model} on ${provider} exceeds the ` +
          `${ARCH_WINDOW_CAP_TOKENS}-token local heuristic cap — honoring it as configured ` +
          `(explicit config is never clamped), but a window this large can allocate a ` +
          `multi-GB KV cache; verify the server really serves it.`,
      );
    }
    return { contextWindow: configWindow, source: 'config', capped: false, diagnostics };
  }

  if (probedWindow !== undefined) {
    if (probe?.source === 'architecture' && probedWindow > ARCH_WINDOW_CAP_TOKENS) {
      diagnostics.push(
        `context window for ${model} on ${provider}: probed ${probedWindow} tokens is ` +
          `architecture-derived (an upper bound, not an allocation) — capped to ` +
          `${ARCH_WINDOW_CAP_TOKENS} to avoid pathological KV-cache allocation. ` +
          `Set 'contextWindow' in ~/.ethos/config.yaml to override.`,
      );
      return {
        contextWindow: ARCH_WINDOW_CAP_TOKENS,
        source: 'probe',
        capped: true,
        diagnostics,
      };
    }
    return { contextWindow: probedWindow, source: 'probe', capped: false, diagnostics };
  }

  // The probe ran but could not resolve a window — surface its diagnostic.
  if (probe?.diagnostic) diagnostics.push(probe.diagnostic);

  if (catalogWindow !== undefined) {
    if (localRuntime && catalogWindow > ARCH_WINDOW_CAP_TOKENS) {
      diagnostics.push(
        `context window for ${model} on ${provider}: catalog advertises ${catalogWindow} ` +
          `tokens (architecture-derived) — capped to ${ARCH_WINDOW_CAP_TOKENS} to avoid ` +
          `pathological KV-cache allocation. Set 'contextWindow' in ~/.ethos/config.yaml ` +
          `to override.`,
      );
      return {
        contextWindow: ARCH_WINDOW_CAP_TOKENS,
        source: 'catalog',
        capped: true,
        diagnostics,
      };
    }
    return { contextWindow: catalogWindow, source: 'catalog', capped: false, diagnostics };
  }

  if (localRuntime) {
    diagnostics.push(
      `window for ${model} on ${provider} is unknown; assuming 128000 — set contextWindow ` +
        `in ~/.ethos/config.yaml`,
    );
  }
  return { contextWindow: undefined, source: 'default', capped: false, diagnostics };
}
