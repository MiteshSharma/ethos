// Lane 6 — assemble the model-fit verdict for ONE personality. This is the
// impure companion to `computeModelFit()` (model-fit.ts): it resolves the
// served window (Lane 0 precedence: config > probe > catalog > default,
// cache-first probe with an optional live refresh for diagnostic commands,
// D16), measures the static floor from the SERIALIZED tool schemas (Lane 3 /
// D8), derives the small-window state + declared narrowing the loop would run
// with, and hands the numbers to the pure verdict.
//
// Both surfaces call this ONE assembler — the CLI (`ethos personality show`)
// and the `personalities.characterSheet` RPC (via the `modelFit` seam threaded
// through createWebApi) — so the two can never disagree on the arithmetic.

import { parseSmallWindowToolset } from '@ethosagent/core';
import type { CharacterSheetModelFit } from '@ethosagent/personalities';
import { INJECTION_DEFENSE_PRELUDE } from '@ethosagent/safety-injection';
import type { PersonalityConfig, Storage } from '@ethosagent/types';
import {
  detectLocalRuntime,
  probeServedWindowCached,
  resolveContextWindow,
  type WindowProbeResult,
  windowProbeCachePath,
} from './local-models';
import {
  lookupContextWindow,
  PROVIDER_WINDOW_DEFAULTS,
  resolveSmallWindowMode,
} from './model-catalog';
import { computeModelFit } from './model-fit';
import { measureStaticFloor } from './static-floor';

export interface ResolvePersonalityModelFitOptions {
  personality: PersonalityConfig;
  /** SOUL.md body ('' when the personality has no soul file). */
  soulMd: string;
  /** `toolRegistry.toDefinitions(personality.toolset)` — the serialized-schema
   *  payload is the floor's denominator term (D8), so pass the REAL
   *  definitions, never a name list. */
  toolDefinitions: readonly unknown[];
  provider: string;
  /** Model this personality's turns run on (modelRouting-aware). */
  model: string;
  baseUrl?: string;
  /** Operator `contextWindow` override — pass only when `model` is the
   *  primary configured model (mirrors createLLMFromRegistry's isPrimary). */
  configWindow?: number;
  /** `compaction.smallWindow` from ~/.ethos/config.yaml. */
  smallWindowOverride?: 'auto' | 'on' | 'off';
  storage: Storage;
  dataDir: string;
  /** D16 — diagnostic commands probe LIVE and rewrite the cache. */
  forceProbeRefresh?: boolean;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** Resolve the window, measure the floor, and compute the fit verdict. */
export async function resolvePersonalityModelFit(
  opts: ResolvePersonalityModelFitOptions,
): Promise<CharacterSheetModelFit> {
  // Lane 0 — the numerator. Hosted endpoints are never probed; a probe miss
  // or an unknown runtime falls through to catalog, then to `default`
  // (→ verdict `unknown`, no arithmetic).
  const runtime = detectLocalRuntime(opts.provider, opts.baseUrl ?? '');
  let probe: WindowProbeResult | undefined;
  if (runtime !== undefined && opts.baseUrl !== undefined) {
    probe = await probeServedWindowCached({
      runtime,
      baseUrl: opts.baseUrl,
      model: opts.model,
      storage: opts.storage,
      cachePath: windowProbeCachePath(opts.dataDir),
      ...(opts.forceProbeRefresh !== undefined ? { forceRefresh: opts.forceProbeRefresh } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  const catalogWindow =
    lookupContextWindow(opts.provider, opts.model) ?? PROVIDER_WINDOW_DEFAULTS[opts.provider];
  const resolved = resolveContextWindow({
    provider: opts.provider,
    model: opts.model,
    ...(opts.configWindow !== undefined ? { configWindow: opts.configWindow } : {}),
    ...(probe !== undefined ? { probe } : {}),
    ...(catalogWindow !== undefined ? { catalogWindow } : {}),
    localRuntime: runtime !== undefined,
  });

  // Lane 1/3 (D8) — the denominator: the ONE static-floor arithmetic, fed the
  // serialized tool-schema payload. Full prelude, matching `ethos bench
  // context`'s default posture.
  const floor = measureStaticFloor({
    soulChars: opts.soulMd.length,
    toolSchemaChars: JSON.stringify(opts.toolDefinitions).length,
    toolCount: opts.toolDefinitions.length,
    preludeChars: INJECTION_DEFENSE_PRELUDE.length,
  });

  // Small-window state + declared narrowing — the same derivation
  // build-agent-loop runs at loop construction (Lane 3's visibility handoff:
  // the narrowing must be visible on the character sheet, not just a log line).
  const windowKnown = resolved.contextWindow !== undefined && resolved.source !== 'default';
  const smallWindow =
    windowKnown &&
    resolveSmallWindowMode({
      contextWindow: resolved.contextWindow,
      staticTokens: floor.tokens,
      ...(opts.smallWindowOverride !== undefined ? { override: opts.smallWindowOverride } : {}),
    });
  const declaredSmallSet = parseSmallWindowToolset(
    opts.personality.context_engine_options?.small_window_toolset,
  );
  const toolset = opts.personality.toolset;
  const narrowedToolset =
    smallWindow && declaredSmallSet
      ? toolset
        ? toolset.filter((t) => declaredSmallSet.includes(t))
        : declaredSmallSet
      : undefined;

  return computeModelFit({
    personalityId: opts.personality.id,
    model: opts.model,
    ...(resolved.contextWindow !== undefined ? { windowTokens: resolved.contextWindow } : {}),
    windowSource: resolved.source,
    floor,
    smallWindow,
    ...(narrowedToolset !== undefined ? { narrowedToolset } : {}),
    mcpServerCount: (opts.personality.mcp_servers ?? []).length,
    declaresModelTiers: typeof opts.personality.model === 'object',
  });
}
