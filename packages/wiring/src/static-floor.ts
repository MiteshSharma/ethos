// Lane 1(b) + eng review D8 — THE static-floor arithmetic, in one place.
//
// `build-agent-loop.ts` (small-window trigger + startup floor warning) and
// `ethos bench context` (`measurePersonalityStatic`) previously duplicated the
// chars/4 estimate; Lane 3's schema-budget warning and Lane 6's fit verdict
// will consume this module too. One measurement, N consumers — no second
// arithmetic path. Everything here is pure: inputs in, token estimate +
// per-component breakdown out, no I/O.

import { DEFAULT_OUTPUT_RESERVE_TOKENS } from '@ethosagent/core';

/** The chars/4 heuristic every consumer of this module shares. */
const CHARS_PER_TOKEN = 4;

export interface StaticFloorInputs {
  /** SOUL.md length in chars (0 when the personality has no soul file). */
  soulChars: number;
  /** `JSON.stringify(tools.toDefinitions(toolset)).length`. */
  toolSchemaChars: number;
  /** Number of tool schemas measured — diagnostics only. */
  toolCount: number;
  /** Injection-defense prelude length (full or compact, caller-resolved). */
  preludeChars: number;
}

export interface StaticFloorComponent {
  name: string;
  chars: number;
  tokens: number;
}

export interface StaticFloorMeasurement {
  totalChars: number;
  /** `ceil(totalChars / 4)` — the exact number the compaction gate is fed. */
  tokens: number;
  components: StaticFloorComponent[];
  toolCount: number;
}

/** Estimate the static prompt floor. Pure; same formula as the gate (chars/4). */
export function measureStaticFloor(inputs: StaticFloorInputs): StaticFloorMeasurement {
  const est = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
  const components: StaticFloorComponent[] = [
    { name: 'SOUL.md', chars: inputs.soulChars, tokens: est(inputs.soulChars) },
    { name: 'tool schemas', chars: inputs.toolSchemaChars, tokens: est(inputs.toolSchemaChars) },
    {
      name: 'injection-defense prelude',
      chars: inputs.preludeChars,
      tokens: est(inputs.preludeChars),
    },
  ];
  const totalChars = inputs.soulChars + inputs.toolSchemaChars + inputs.preludeChars;
  return { totalChars, tokens: est(totalChars), components, toolCount: inputs.toolCount };
}

/** The gate's output reserve for a window — mirrors `evaluateGate` exactly. */
export function outputReserveTokens(windowTokens: number): number {
  return Math.min(DEFAULT_OUTPUT_RESERVE_TOKENS, Math.floor(windowTokens / 2));
}

export interface ContextFitVerdict {
  windowTokens: number;
  outputReserveTokens: number;
  /** `window − output reserve − static floor`; ≤ 0 → the personality cannot run. */
  compactibleTokens: number;
  /**
   * Set when `compactibleTokens ≤ 0` — the Lane 1(b) diagnostic. Names the
   * personality, the model, the window, and the LARGEST contributing component
   * with its token count. Shipped WARN-FIRST at loop construction (plan risk
   * note: some configs that "work" today only work because the server silently
   * truncates); Lane 6's arithmetic verdict reuses the same text.
   */
  message?: string;
}

/** Evaluate whether a personality's static floor leaves any compactible room. */
export function evaluateContextFit(opts: {
  personalityId: string;
  model: string;
  windowTokens: number;
  floor: StaticFloorMeasurement;
}): ContextFitVerdict {
  const reserve = outputReserveTokens(opts.windowTokens);
  const compactibleTokens = opts.windowTokens - reserve - opts.floor.tokens;
  const base = {
    windowTokens: opts.windowTokens,
    outputReserveTokens: reserve,
    compactibleTokens,
  };
  if (compactibleTokens > 0) return base;

  const n = (v: number) => v.toLocaleString('en-US');
  const largest = [...opts.floor.components].sort((a, b) => b.tokens - a.tokens)[0];
  const largestNote = largest
    ? ` Largest contributor: ${largest.name} (${n(largest.tokens)} tokens${
        largest.name === 'tool schemas' ? `, ${opts.floor.toolCount} tools` : ''
      }).`
    : '';
  return {
    ...base,
    message:
      `personality \`${opts.personalityId}\` cannot run on \`${opts.model}\` ` +
      `(${n(opts.windowTokens)} tokens): static prefix ${n(opts.floor.tokens)} + ` +
      `output reserve ${n(reserve)} exceeds the window.${largestNote}`,
  };
}

// ---------------------------------------------------------------------------
// Lane 1(c) + (e) — window-scaled per-turn tool-result budget
// ---------------------------------------------------------------------------

/**
 * The flat default per-turn tool-result budget (`agent-loop.ts` `?? 80_000`)
 * — and the CEILING. Increasing the window must never raise the per-result
 * cap past this value (#111762): a bigger cap means less reduction, and the
 * model drowns in raw output it could have had summarized. Scale DOWN for
 * small windows; never UP for large ones.
 */
export const RESULT_BUDGET_CEILING_CHARS = 80_000;

/** Never scale the budget below this — a tool that cannot return ~500 tokens
 *  of output is useless, and the diagnostic path (Lane 1b) is the right tool
 *  for a window that small, not a zeroed budget. */
export const RESULT_BUDGET_FLOOR_CHARS = 2_000;

/**
 * Share of the compactible region a single tool result may claim: 1/4 leaves
 * room for the surrounding conversation plus at least three more same-sized
 * results before the pressure gate must fire — small enough that one
 * `read_file` cannot immediately undo a fresh compaction, large enough to
 * stay useful on an 8k window (~4,096 chars there).
 */
const RESULT_BUDGET_COMPACTIBLE_SHARE = 0.25;

/**
 * Resolve the effective per-turn `resultBudgetChars` for a served window:
 * `min(configured-or-default, windowDerivedCap)` where the window-derived cap
 * is a quarter of the compactible region in chars. On frontier windows this
 * resolves to the ceiling and the loop options are byte-identical to today.
 * An explicit `configured` value (the `context_engine_options.resultBudgetChars`
 * knob) can lower the budget further but never raise it past the ceiling.
 */
export function resolveResultBudget(opts: {
  windowTokens: number;
  staticFloorTokens: number;
  configured?: number;
}): number {
  // (e) cap-the-cap: an override may only lower, never exceed, the flat default.
  const base = Math.min(
    opts.configured ?? RESULT_BUDGET_CEILING_CHARS,
    RESULT_BUDGET_CEILING_CHARS,
  );
  const compactibleTokens = Math.max(
    0,
    opts.windowTokens - outputReserveTokens(opts.windowTokens) - opts.staticFloorTokens,
  );
  const windowDerivedCap = Math.floor(
    compactibleTokens * CHARS_PER_TOKEN * RESULT_BUDGET_COMPACTIBLE_SHARE,
  );
  return Math.min(base, Math.max(RESULT_BUDGET_FLOOR_CHARS, windowDerivedCap));
}
