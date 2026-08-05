// Lane 1(b) + eng review D8 — THE static-floor arithmetic, in one place.
//
// `build-agent-loop.ts` (small-window trigger + startup floor warning) and
// `ethos bench context` (`measurePersonalityStatic`) previously duplicated the
// chars/4 estimate; Lane 3's schema-budget warning and Lane 6's fit verdict
// will consume this module too. One measurement, N consumers — no second
// arithmetic path. Everything here is pure: inputs in, token estimate +
// per-component breakdown out, no I/O.

import { DEFAULT_OUTPUT_RESERVE_TOKENS } from '@ethosagent/core';
import { SMALL_WINDOW_STATIC_RATIO } from './model-catalog';

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

// ---------------------------------------------------------------------------
// Lane 3(a) — total tool-payload guard
// ---------------------------------------------------------------------------

/** Minimal structural view of a tool definition — what the guard and the
 *  budget need. `ToolRegistry.toDefinitions()` output satisfies it. */
export interface MeasurableToolDefinition {
  name: string;
}

/**
 * Default total-payload guard threshold: 128 KiB of serialized tool-schema
 * JSON (~32k tokens at chars/4). Rationale: 32k tokens is the entire budget of
 * a small-window local deployment (`SMALL_WINDOW_MAX_TOKENS`) — a tool payload
 * past this cannot leave room for a single message even before llama.cpp's
 * grammar/template expansion, and llamacpp-class runtimes degrade or drop tool
 * calling entirely well before it. It is also >4x the serialized size of a
 * heavy first-party Ethos toolset, so no sane configuration trips it — only
 * runaway MCP-borne schema payloads do. Override with `toolPayloadLimitChars`
 * in ~/.ethos/config.yaml.
 */
export const TOOL_PAYLOAD_GUARD_DEFAULT_CHARS = 131_072;

/** Serialized per-tool schema sizes, largest first. */
export function measureToolSchemaSizes(
  toolDefinitions: readonly MeasurableToolDefinition[],
): Array<{ name: string; chars: number }> {
  return toolDefinitions
    .map((d) => ({ name: d.name, chars: JSON.stringify(d).length }))
    .sort((a, b) => b.chars - a.chars);
}

export interface ToolPayloadGuardVerdict {
  totalChars: number;
  limitChars: number;
  /**
   * Set when the payload exceeds the limit. `'fail'` on a local dialect —
   * startup must refuse, because past the limit llamacpp-class runtimes lose
   * tool calling entirely (the failure this guard prevents); `'warn'` on
   * hosted dialects. In neither case is the problem deferred to the first
   * tool call.
   */
  severity?: 'fail' | 'warn';
  /** Set with `severity` — names the offending tools in both cases. */
  message?: string;
}

/** Evaluate the Lane 3(a) total serialized tool-payload guard. Pure. */
export function evaluateToolPayloadGuard(opts: {
  toolDefinitions: readonly MeasurableToolDefinition[];
  limitChars?: number;
  /** True when the provider endpoint is a detected local runtime. */
  localDialect: boolean;
}): ToolPayloadGuardVerdict {
  const limitChars = opts.limitChars ?? TOOL_PAYLOAD_GUARD_DEFAULT_CHARS;
  const totalChars = JSON.stringify(opts.toolDefinitions).length;
  if (totalChars <= limitChars) return { totalChars, limitChars };

  const n = (v: number) => v.toLocaleString('en-US');
  const offenders = measureToolSchemaSizes(opts.toolDefinitions)
    .slice(0, 3)
    .map((t) => `${t.name} (${n(t.chars)} chars)`)
    .join(', ');
  return {
    totalChars,
    limitChars,
    severity: opts.localDialect ? 'fail' : 'warn',
    message:
      `serialized tool payload is ${n(totalChars)} chars, over the ${n(limitChars)}-char ` +
      `guard — llamacpp-class runtimes lose tool calling entirely past this. ` +
      `Largest tool schemas: ${offenders}. Trim the personality's toolset (or its MCP ` +
      `servers' schemas), or raise toolPayloadLimitChars in ~/.ethos/config.yaml.`,
  };
}

// ---------------------------------------------------------------------------
// Lane 3(b) — per-personality tool-schema budget warning
// ---------------------------------------------------------------------------

export interface ToolSchemaBudgetVerdict {
  /** `toolSchemaTokens / windowTokens` — tokens via the same chars/4 estimate
   *  `measureStaticFloor` uses (D8: one arithmetic, no second path). */
  share: number;
  toolSchemaChars: number;
  toolSchemaTokens: number;
  /** The three largest tool schemas, largest first. */
  largest: Array<{ name: string; chars: number; tokens: number }>;
  /** Set when the share exceeds the ratio — names the personality, the share,
   *  and the three largest tool schemas. */
  message?: string;
}

/**
 * Evaluate whether a personality's serialized tool schemas exceed a share of
 * the served window. The default ratio reuses `SMALL_WINDOW_STATIC_RATIO`
 * (0.4) — an existing, reviewed constant — and the token arithmetic is the
 * same chars/4 estimate `measureStaticFloor` and `ethos bench context` report,
 * so the warning threshold and the bench measurement can never disagree.
 */
export function evaluateToolSchemaBudget(opts: {
  personalityId: string;
  windowTokens: number;
  toolDefinitions: readonly MeasurableToolDefinition[];
  ratio?: number;
}): ToolSchemaBudgetVerdict {
  const ratio = opts.ratio ?? SMALL_WINDOW_STATIC_RATIO;
  const toolSchemaChars = JSON.stringify(opts.toolDefinitions).length;
  const toolSchemaTokens = Math.ceil(toolSchemaChars / CHARS_PER_TOKEN);
  const largest = measureToolSchemaSizes(opts.toolDefinitions)
    .slice(0, 3)
    .map((t) => ({ ...t, tokens: Math.ceil(t.chars / CHARS_PER_TOKEN) }));
  const share = opts.windowTokens > 0 ? toolSchemaTokens / opts.windowTokens : 0;
  const base = { share, toolSchemaChars, toolSchemaTokens, largest };
  if (opts.windowTokens <= 0 || share <= ratio) return base;

  const n = (v: number) => v.toLocaleString('en-US');
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const top = largest.map((t) => `${t.name} (~${n(t.tokens)} tokens)`).join(', ');
  return {
    ...base,
    message:
      `personality \`${opts.personalityId}\`: tool schemas cost ~${n(toolSchemaTokens)} tokens — ` +
      `${pct(share)} of the ${n(opts.windowTokens)}-token served window (threshold ${pct(ratio)}). ` +
      `Largest: ${top}. Trim toolset.yaml, or declare ` +
      `context_engine_options.small_window_toolset to narrow it in small-window mode.`,
  };
}
