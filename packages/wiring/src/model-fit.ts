// Lane 6 (eng review D5 + D19) — the arithmetic per-personality model-fit
// verdict. PURE: inputs in, verdict data out. This module must never do I/O
// (no fetch, no storage, no probe) — that is the offline criterion the lane
// ships under. Window resolution and schema measurement happen in the caller
// (see `resolvePersonalityModelFit` in personality-fit.ts); this file is only
// the division and the sentence.
//
// The verdict object is `CharacterSheetModelFit` from @ethosagent/personalities
// — plain data the single character-sheet generator renders for both the CLI
// (`ethos personality show`) and the `personalities.characterSheet` RPC. The
// type lives in the personalities package so the renderer never imports wiring
// (layer direction, D5).

import type { CharacterSheetModelFit } from '@ethosagent/personalities';
import { SMALL_WINDOW_STATIC_RATIO } from './model-catalog';
import { evaluateContextFit, type StaticFloorMeasurement } from './static-floor';

export interface ComputeModelFitInputs {
  personalityId: string;
  /** Model the verdict is computed against. */
  model: string;
  /** Resolved served window in tokens (Lane 0). Absent → unresolved. */
  windowTokens?: number;
  /** Lane 0 resolution source. `'default'` means NOTHING resolved — the
   *  verdict is then `unknown` and no arithmetic runs against the 128k
   *  fallback (D19). */
  windowSource: 'config' | 'probe' | 'catalog' | 'default';
  /** The personality's static floor from `measureStaticFloor()` — serialized
   *  tool-schema size, not toolset name count (D8). */
  floor: StaticFloorMeasurement;
  /** Whether small-window mode is active for this window + floor. */
  smallWindow: boolean;
  /** Surviving tool names when the personality's declared
   *  `small_window_toolset` narrowing is in effect (Lane 3). */
  narrowedToolset?: readonly string[];
  /** MCP servers declared in the personality's mcp.yaml — their schemas are
   *  unknown until connect, so they are a named exclusion, not a term. */
  mcpServerCount: number;
  /** True when the personality declares per-tier models — tier-routed turns
   *  are not separately evaluated (named exclusion, D19). */
  declaresModelTiers: boolean;
}

/**
 * Compute the arithmetic model-fit verdict.
 *
 * - `unknown`       — the window could not be resolved; NO division happens.
 * - `refuses`       — `compactible ≤ 0`; the refusal reason is the Lane 1(b)
 *                     diagnostic from `evaluateContextFit` (one function, both
 *                     places) naming the largest component with token count.
 * - `fits-degraded` — runs, but with named arithmetic costs.
 * - `fits`          — static floor + working history budget fit the window.
 */
export function computeModelFit(inputs: ComputeModelFitInputs): CharacterSheetModelFit {
  const exclusions: string[] = [];
  if (inputs.mcpServerCount > 0) {
    exclusions.push(
      `${inputs.mcpServerCount} MCP server${inputs.mcpServerCount === 1 ? '' : 's'} not counted — schemas unknown until connect`,
    );
  }
  if (inputs.declaresModelTiers) exclusions.push('tier models not evaluated');

  const floor = {
    tokens: inputs.floor.tokens,
    toolCount: inputs.floor.toolCount,
    components: inputs.floor.components.map((c) => ({ name: c.name, tokens: c.tokens })),
  };

  // D19 — an unresolved window yields `unknown`. The 128,000-token provider
  // default is a guess, and a verdict divided by a guess would be a lie with
  // arithmetic authority behind it. No numbers, no division.
  if (inputs.windowTokens === undefined || inputs.windowSource === 'default') {
    return {
      verdict: 'unknown',
      model: inputs.model,
      windowSource: inputs.windowSource,
      floor,
      degradations: [],
      exclusions,
    };
  }

  const windowTokens = inputs.windowTokens;
  // Lane 1(b) reuse — the SAME function that produces the startup warn
  // diagnostic produces the refusal here; the two texts can never drift.
  const fit = evaluateContextFit({
    personalityId: inputs.personalityId,
    model: inputs.model,
    windowTokens,
    floor: inputs.floor,
  });
  const staticShare = inputs.floor.tokens / windowTokens;
  const base = {
    model: inputs.model,
    windowTokens,
    windowSource: inputs.windowSource,
    floor,
    outputReserveTokens: fit.outputReserveTokens,
    compactibleTokens: fit.compactibleTokens,
    staticShare,
    exclusions,
  };

  if (fit.message !== undefined) {
    return { ...base, verdict: 'refuses', degradations: [], refusalReason: fit.message };
  }

  const degradations: string[] = [];
  if (inputs.smallWindow) degradations.push('small-window mode active');
  if (inputs.narrowedToolset !== undefined) {
    degradations.push(
      `toolset narrowed to declared small_window_toolset (${inputs.narrowedToolset.length} tool${
        inputs.narrowedToolset.length === 1 ? '' : 's'
      }): ${inputs.narrowedToolset.join(', ') || '(none)'}`,
    );
  }
  if (staticShare > SMALL_WINDOW_STATIC_RATIO) {
    degradations.push(
      `static floor is ${Math.round(staticShare * 100)}% of the window (budget ratio ${Math.round(SMALL_WINDOW_STATIC_RATIO * 100)}%)`,
    );
  }

  return { ...base, verdict: degradations.length > 0 ? 'fits-degraded' : 'fits', degradations };
}
