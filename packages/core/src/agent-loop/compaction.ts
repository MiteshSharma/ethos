import type {
  ContextEngineLLMHandle,
  ContextEngineRegistry,
  ContextEngineStore,
  LLMProvider,
  Message,
  PersonalityConfig,
  SessionStore,
  Storage,
} from '@ethosagent/types';
import {
  estimateMessagesChars,
  estimateMessagesTokens,
  estimateTokens,
} from '../context-engines/token-estimator';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';

// Phase 2 watermark helpers (selectActiveWatermark, reconstructFromWatermark,
// computeKeptTailBoundary, runManualCompaction, compactSession) live in
// ./manual-compact. This module owns only the pressure-gated auto path below.

export interface CompactionDeps {
  llm: LLMProvider;
  contextEngines: ContextEngineRegistry;
  session: SessionStore;
  observability?: AgentLoopObservability;
  /** Context-engine LLM handle — preferred over engine-constructor injection. */
  llmHandle?: ContextEngineLLMHandle;
  /** Raw storage + dataDir for building a per-personality ContextEngineStore. */
  storage?: Storage;
  dataDir?: string;
  /** Framework-owned, model-pinned token counter. */
  countTokens?: (messages: Message[]) => Promise<number>;
  /**
   * T3 — max output tokens the pending completion may generate. Reserved from
   * the window before computing pressure so the *response* can't push the
   * request past the context limit. Defaults to `DEFAULT_OUTPUT_RESERVE_TOKENS`
   * when the caller didn't set a completion budget.
   */
  reservedOutputTokens?: number;
  /**
   * §5 — pressure gate as a fraction of the window in (0,1]. Compaction fires
   * when estimated usage exceeds this. Defaults to 0.8 when unset. Resolved
   * upstream as: per-model profile > global `compaction:` config > this default.
   */
  pressure?: number;
  /**
   * §5 — target usage as a fraction of the window in (0,1]; compaction shrinks
   * toward it. Defaults to 0.7 when unset. Same precedence as `pressure`.
   */
  target?: number;
  /**
   * Item 7 — absolute compaction ceiling, in whole-context tokens. Compaction
   * fires when usage exceeds EITHER the fractional pressure gate OR this value,
   * whichever is LOWER — so a million-token window does not have to reach 800k
   * before the history is compressed. It also caps the shrink budget (the
   * target becomes `targetFraction` of the ceiling), otherwise the compaction
   * would aim above the ceiling and re-trip the gate as soon as the cooldown
   * expires. Resolved upstream from the global `compaction.maxContextTokens`
   * config; absent or non-positive → fractional gates only, unchanged.
   */
  maxContextTokens?: number;
  /**
   * Lane 1(a) delta — the largest single tool result the NEXT turn could add,
   * in tokens (derived upstream from the effective per-call result budget).
   * Reserved out of the compactible region alongside the static slice, so the
   * gate fires early enough that a compaction which succeeds is not undone by
   * the very next `read_file`:
   *
   *   compactible = window − static_prefix − reserved_output − max_single_tool_result
   *
   * Absent or 0 → the arithmetic is byte-identical to before (the hosted
   * default; wiring only sets it when the window-scaled result budget is
   * below its ceiling).
   */
  maxSingleToolResultTokens?: number;
  /**
   * §5 — per-model gate estimator divisor (chars per token). When set, the gate
   * computes usage as `chars / charsPerToken` INSTEAD of char/4 and does NOT
   * apply the small-window safety factor (this is the accurate per-model value —
   * inflating it would double-count). Absent → char/4 + small-window factor.
   */
  charsPerToken?: number;
  /**
   * Phase 1c — actuals-first gate signal: the previous turn's REAL input-token
   * count (persisted by Phase 0). When present it replaces the chars/4 estimate
   * as `current` usage — the estimator apparatus already mispredicted (est
   * <157k vs API-reported 180k). Absent on the first turn → the estimator
   * fallback applies. Added to `gateDelta` to account for this turn's growth.
   */
  lastActualInputTokens?: number;
  /**
   * Phase 1c — measured static sections (system + tools) in tokens from the
   * previous turn. The gate subtracts this from the window so pressure applies
   * to the MESSAGES slice, not the whole estimate — a model whose static
   * overhead alone approaches the window is then handled correctly. Absent → 0
   * (gate is byte-identical to before).
   */
  staticTokens?: number;
  /**
   * Phase 1c — configurable headroom (tokens) added to `lastActualInputTokens`
   * so the gate fires slightly BEFORE the next turn actually reaches pressure.
   * Only consulted on the actuals path. Defaults to 0.
   */
  gateDelta?: number;
  /**
   * Phase 3 — per-model-class default context engine, applied when the
   * personality does NOT declare `context_engine`. Frontier models resolve to
   * `semantic_summary` (when a summarizer is wired), local/weak models to
   * `drop_oldest`. Absent → `drop_oldest` (unchanged).
   */
  defaultEngine?: string;
  /**
   * Phase 3 — force the compaction through regardless of the pressure gate and
   * the anti-thrashing cooldown. Set by the overflow→compact-and-retry path,
   * where the provider already rejected the request for being too long, so
   * gating on an estimate is moot. Absent/false → the normal gated path.
   */
  force?: boolean;
}

/**
 * Phase 3 — pure evaluation of the model-aware pressure gate. Extracted from
 * `maybeCompact` so the turn-end trigger (flush at 70% / compact at 80%) shares
 * the exact same arithmetic (output reserve, static-slice subtraction, small-
 * window safety factor, charsPerToken, actuals-first floor). Returns whole-
 * context token figures; callers derive a threshold with {@link gateThreshold}.
 */
export interface GateEval {
  /** Estimated (or actuals-floored) whole-context usage in tokens. */
  current: number;
  /** Model window after the output reserve is subtracted. */
  window: number;
  /** `window` minus the measured static (system+tools) slice and the
   *  max-single-tool-result reserve (Lane 1a) — the compactible region. */
  messagesWindow: number;
  /** Measured static (system+tools) tokens, clamped to `[0, window]`. */
  staticTokens: number;
}

export function evaluateGate(
  deps: Pick<
    CompactionDeps,
    | 'llm'
    | 'reservedOutputTokens'
    | 'staticTokens'
    | 'maxSingleToolResultTokens'
    | 'charsPerToken'
    | 'lastActualInputTokens'
    | 'gateDelta'
  >,
  messages: Message[],
  systemPrompt: string,
): GateEval {
  const rawWindow = deps.llm.maxContextTokens || 200_000;
  const requestedOutput = deps.reservedOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const outputReserve = Math.min(Math.max(0, requestedOutput), Math.floor(rawWindow / 2));
  const window = rawWindow - outputReserve;

  const staticTokens = Math.max(0, Math.min(deps.staticTokens ?? 0, window));
  // Lane 1(a) — the fourth term. One arithmetic for both gates: the reserve
  // narrows `messagesWindow`, so `gateThreshold` (pre-LLM gate + turn-end
  // trigger) and `maybeCompact`'s shrink target all honour it without a second
  // threshold path. 0 when unset → identical to before.
  const maxSingleToolResult = Math.max(0, deps.maxSingleToolResultTokens ?? 0);
  const messagesWindow = Math.max(0, window - staticTokens - maxSingleToolResult);

  const charsPerToken = deps.charsPerToken;
  let estimate: number;
  if (charsPerToken !== undefined) {
    estimate = Math.ceil((systemPrompt.length + estimateMessagesChars(messages)) / charsPerToken);
  } else {
    const safetyFactor = rawWindow <= SMALL_WINDOW_THRESHOLD ? SMALL_WINDOW_SAFETY_FACTOR : 1;
    estimate = Math.ceil(
      (estimateTokens(systemPrompt) + estimateMessagesTokens(messages)) * safetyFactor,
    );
  }
  const current =
    deps.lastActualInputTokens !== undefined
      ? Math.max(estimate, deps.lastActualInputTokens + Math.max(0, deps.gateDelta ?? 0))
      : estimate;
  return { current, window, messagesWindow, staticTokens };
}

/** Whole-context token threshold for a pressure fraction `f` in (0,1]. */
export function gateThreshold(g: GateEval, fraction: number): number {
  return g.staticTokens + Math.floor(g.messagesWindow * fraction);
}

/**
 * Item 7 — the gate the framework actually compares against: the fractional
 * threshold, lowered by the absolute ceiling when one is configured. Shared by
 * the pre-LLM gate and the turn-end trigger so both honour the ceiling.
 * `undefined`/non-positive `maxContextTokens` → the fractional threshold.
 */
export function effectiveGate(g: GateEval, fraction: number, maxContextTokens?: number): number {
  const fractional = gateThreshold(g, fraction);
  return maxContextTokens !== undefined && maxContextTokens > 0
    ? Math.min(fractional, maxContextTokens)
    : fractional;
}

// T3 — gate-hardening constants (generic, no per-model config).
/**
 * Output-token headroom reserved when the caller doesn't specify a completion
 * budget. Keeps the pending response from pushing the request past the window.
 * Exported (via `@ethosagent/core`) so wiring's startup floor diagnostic and
 * result-budget scaling share the gate's exact reserve arithmetic (Lane 1b/1c).
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;
/**
 * Windows at or below this size get a conservative estimate inflation: char/4
 * undershoots real local tokenizers (~3.3–3.8 char/tok, worse on dense code)
 * by ~15%, and overflowing a small window is fatal. Large (Anthropic-class)
 * windows are left effectively unchanged — the factor only bites here.
 */
const SMALL_WINDOW_THRESHOLD = 16_000;
const SMALL_WINDOW_SAFETY_FACTOR = 1.15;

// ---------------------------------------------------------------------------
// E4 — pre-LLM compaction. Resolves the personality's context engine and
// calls into it when estimated context usage exceeds the pressure
// threshold (80% of the model's window). When the personality declares no
// engine, we still resolve to `drop_oldest` — but the engine is only
// *invoked* when there is real pressure, so static configs see no change.
// ---------------------------------------------------------------------------
export async function maybeCompact(
  deps: CompactionDeps,
  messages: Message[],
  systemPrompt: string,
  personality: PersonalityConfig,
  sessionMetadata: {
    sessionId: string;
    sessionKey: string;
    turnNumber: number;
    lastCompactionTurn: number;
    /**
     * Phase 2 — watermark boundary. The id of the first stored message to keep
     * verbatim; recorded on the compression row so the compaction is replayed
     * into later turns instead of being re-derived from raw history. Absent →
     * the row is not a replayable watermark (legacy ephemeral behavior).
     */
    keptFromMessageId?: string;
  },
): Promise<{
  messages: Message[];
  cacheBreakpoints?: number[];
  notice?: { engineName: string; droppedCount: number; summaryTokens: number };
}> {
  // §5 — effective gate/target fractions. Resolved upstream (per-model profile >
  // global config); the hardcoded 0.8/0.7 defaults live here so an unset caller
  // is byte-identical to before.
  const pressureFraction = deps.pressure ?? 0.8;
  const targetFraction = deps.target ?? 0.7;

  // Phase 3 — the gate arithmetic is shared with the turn-end trigger via
  // `evaluateGate` (output reserve, static-slice subtraction, small-window
  // factor, charsPerToken, actuals-first floor all live there).
  const g = evaluateGate(deps, messages, systemPrompt);
  const { current, window, messagesWindow } = g;
  // Item 7 — the absolute ceiling lowers both the gate and the shrink budget.
  const ceiling =
    deps.maxContextTokens !== undefined && deps.maxContextTokens > 0
      ? deps.maxContextTokens
      : undefined;
  const target = Math.floor(Math.min(messagesWindow, ceiling ?? messagesWindow) * targetFraction);
  const pressureGate = effectiveGate(g, pressureFraction, ceiling);

  // Phase 3 — `force` skips both the pressure gate and the cooldown (used by the
  // overflow→compact-and-retry path, where the provider already rejected the
  // request for being too long).
  if (!deps.force) {
    if (current <= pressureGate) return { messages };

    // Q2 — anti-thrashing cooldown. After a compaction, skip the next few
    // turns of *normal* pressure: re-compacting immediately would summarize the
    // summary, degrading meaning. `lastCompactionTurn === 0` means "never
    // compacted" — the first compaction is always allowed through. The cooldown
    // is bypassed under hard overflow (>95% of the window): its job is to
    // prevent summary churn, not to disable context-limit protection.
    const cooldownTurns = 5;
    const hardOverflowGate = Math.floor(window * 0.95);
    const inCooldown =
      sessionMetadata.lastCompactionTurn > 0 &&
      sessionMetadata.turnNumber - sessionMetadata.lastCompactionTurn < cooldownTurns;
    if (inCooldown && current <= hardOverflowGate) {
      return { messages };
    }
  }

  const engineName = personality.context_engine ?? deps.defaultEngine ?? 'drop_oldest';
  const engine = deps.contextEngines.get(engineName) ?? deps.contextEngines.get('drop_oldest');
  if (!engine) return { messages };

  // Build a per-personality ContextEngineStore when raw storage is available.
  let store: ContextEngineStore | undefined;
  const stStorage = deps.storage;
  const stDataDir = deps.dataDir;
  if (stStorage && stDataDir) {
    const basePath = `${stDataDir}/compaction/${personality.id}`;
    store = {
      read: (key) => stStorage.read(`${basePath}/${key}`),
      write: (key, value) => stStorage.write(`${basePath}/${key}`, value),
      list: () => stStorage.list(basePath),
    };
  }

  try {
    const startedAt = Date.now();
    const result = await engine.compact({
      messages,
      currentSystem: systemPrompt,
      targetTokens: target,
      personality,
      sessionMetadata,
      ...(deps.llmHandle ? { llm: deps.llmHandle } : {}),
      ...(store ? { store } : {}),
      ...(deps.countTokens ? { countTokens: deps.countTokens } : {}),
    });
    const durationMs = Date.now() - startedAt;
    deps.observability?.recordCompaction({
      code: 'context_compacted',
      cause: `${engine.name}: ${result.notes}`,
    });
    // F3 — persist the compaction event so the session stays auditable. The
    // original messages remain in `messages`; this row only records the
    // LLM-facing replay change. Best-effort: a persistence failure must not
    // break the turn, so it never propagates to the fail-open catch below.
    const changed = result.messages.length !== messages.length || result.summaryText !== undefined;
    const summaryTokens = result.summaryText ? estimateTokens(result.summaryText) : 0;
    if (changed) {
      try {
        await deps.session.recordCompression({
          sessionId: sessionMetadata.sessionId,
          engineName: engine.name,
          originalCount: messages.length,
          keptCount: result.messages.length,
          ...(result.summaryText !== undefined ? { summaryText: result.summaryText } : {}),
          ...(sessionMetadata.keptFromMessageId
            ? { keptFromMessageId: sessionMetadata.keptFromMessageId }
            : {}),
          summaryTokens,
          preTotalTokens: current,
          postTotalTokens: estimateTokens(systemPrompt) + estimateMessagesTokens(result.messages),
          durationMs,
        });
        await deps.session.updateUsage(sessionMetadata.sessionId, { compactionCount: 1 });
        // Q2 — mark this turn so the cooldown suppresses the next few turns.
        await deps.session.recordCompactionTurn(
          sessionMetadata.sessionId,
          sessionMetadata.turnNumber,
        );
      } catch (persistErr) {
        deps.observability?.recordCompaction({
          severity: 'warn',
          code: 'compaction_persist_failed',
          cause: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }
    // F2 — forward the engine's stable cache breakpoints to the provider so
    // the prompt cache survives compaction. Only meaningful when the engine
    // actually compacted; a no-op return carries no breakpoints.
    // V1 — `notice` lets the caller surface a one-line in-chat compaction
    // notice; only set when the engine actually changed the history.
    return {
      messages: result.messages,
      ...(changed && result.cacheBreakpoints ? { cacheBreakpoints: result.cacheBreakpoints } : {}),
      ...(changed
        ? {
            notice: {
              engineName: engine.name,
              droppedCount: messages.length - result.messages.length,
              summaryTokens,
            },
          }
        : {}),
    };
  } catch (err) {
    // Fail open — better to send the un-compacted history and let the
    // provider error than to silently drop messages on engine failure.
    deps.observability?.recordCompaction({
      severity: 'warn',
      code: 'context_engine_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
    return { messages };
  }
}
