// Item 7 stage 3 — per-turn micro-compaction.
//
// The problem: compaction is a cliff. Pressure climbs quietly, the gate trips,
// and one turn pays for an LLM summarization pass over the whole prefix while
// the user waits. Micro-compaction amortizes that: a small, bounded slice of
// stale tool_results is rewritten at each 5%-of-window step, so by the time the
// real gate trips there is far less left to compact and no single turn carries
// the whole bill.
//
// It is NOT a second aging scheme. It reuses `tool-result-aging`'s candidate
// pool (`oldToolUseIds`) and its content-only rewrite (`rewriteToolResults`),
// and reproduces all four of that module's cache-safe properties — which exist
// because a rewrite that churns turn over turn permanently invalidates the
// prompt cache and costs money on EVERY subsequent turn:
//
//   1. MONOTONIC LEVEL. `level` is a max against the previous level and never
//      falls, so a ratio dip cannot un-age content and re-invalidate the prefix.
//   2. EARLY RETURN ON NO CROSSING. Between step crossings `advanceMicroState`
//      returns the previous state untouched (`changed: false`), so the same set
//      is reapplied and the rewritten view is byte-identical turn over turn.
//   3. KEYED BY STABLE `tool_use` IDS. Never by array index — the message array
//      grows every turn, so an index-keyed set would drift onto other messages.
//   4. CONTENT-ONLY, IN-PLACE. Delegated to `rewriteToolResults`: no message is
//      removed, added, or reordered, so a `tool_use` / `tool_result` pair can
//      never be split.
//
// State persistence is the CALLER's job, exactly as it is for aging: turn-end
// (`turn-complete.ts`) advances and saves; context assembly loads and applies.
//
// Micro-compaction touches the MESSAGE ARRAY ONLY. It never sees, and can never
// alter, the assembled static prefix — doing so would defeat prefix caching
// outright.

import type { ContextEngineTurnCompleteOutput, Message } from '@ethosagent/types';
import {
  KEEP_RECENT_ASSISTANT_TURNS,
  oldToolUseIds,
  type RewriteOpts,
  rewriteToolResults,
} from './tool-result-aging';

export interface MicroCompactionState {
  /** Monotonic step count. Never decreases. */
  level: number;
  /** `tool_use` ids whose results are soft-trimmed (head + tail kept). */
  trimmed: string[];
  /** `tool_use` ids whose results are cleared to a placeholder. */
  cleared: string[];
}

export const DEFAULT_MICRO_STATE: MicroCompactionState = { level: 0, trimmed: [], cleared: [] };

/**
 * Pressure below which micro-compaction does nothing. Deliberately under
 * `tool-result-aging`'s SOFT_RATIO (0.3): the whole point is to start earlier
 * and in smaller increments than the aging ladder.
 */
export const MICRO_FLOOR_RATIO = 0.2;
/** Window fraction between micro steps. */
export const MICRO_STEP_RATIO = 0.05;
/** Candidate tool results promoted per step — the amortization bound. */
export const MICRO_BATCH = 2;
/** Steps a trimmed id waits before being cleared outright (4 × 5% = 20%). */
export const MICRO_CLEAR_LAG = 4;

/**
 * Nudge that absorbs binary-float error at exact step boundaries — `0.25 - 0.2`
 * is `0.049999999999999996`, which would otherwise put a ratio sitting exactly
 * on a step one level below where it belongs.
 */
const STEP_EPSILON = 1e-9;

/** The step count pressure alone would ask for at this ratio. */
export function levelForRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < MICRO_FLOOR_RATIO) return 0;
  return 1 + Math.floor((ratio - MICRO_FLOOR_RATIO) / MICRO_STEP_RATIO + STEP_EPSILON);
}

/** Append the ids of `next` not already in `base`, preserving `base`'s order. */
function union(base: readonly string[], next: readonly string[]): string[] {
  const seen = new Set(base);
  const out = [...base];
  for (const id of next) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Advance the micro-compaction state for the just-finished turn.
 *
 * `nomination` is the resolved context engine's `onTurnComplete` return value.
 * When an engine supplies ids they REPLACE the framework's default candidate
 * pool (filtered to ids that actually exist in `messages`, so a stale or
 * invented nomination cannot poison the state). When it supplies none — the
 * case for every built-in engine — the framework's own oldest-first pool is
 * used, so micro-compaction works without any engine opting in.
 *
 * Nominations only take effect AT a step crossing, never between them. That is
 * property 2 above and it is not negotiable: honouring a fresh nomination every
 * turn would rewrite the view every turn and defeat prefix caching, which is
 * the exact cost micro-compaction exists to avoid.
 */
export function advanceMicroState(
  prev: MicroCompactionState,
  messages: Message[],
  ratio: number,
  nomination?: ContextEngineTurnCompleteOutput | null,
  opts?: { keepRecentAssistantTurns?: number },
): { state: MicroCompactionState; changed: boolean } {
  const level = Math.max(prev.level, levelForRatio(ratio));
  if (level === prev.level) return { state: prev, changed: false };

  const keep = opts?.keepRecentAssistantTurns ?? KEEP_RECENT_ASSISTANT_TURNS;
  const defaults = oldToolUseIds(messages, keep);
  const present = new Set(defaults);
  const nominatedTrim = (nomination?.trimToolResults ?? []).filter((id) => present.has(id));
  const nominatedClear = (nomination?.clearToolResults ?? []).filter((id) => present.has(id));
  const pool = nominatedTrim.length > 0 ? nominatedTrim : defaults;

  const clearTake = Math.max(0, (level - MICRO_CLEAR_LAG) * MICRO_BATCH);
  const cleared = union(union(prev.cleared, pool.slice(0, clearTake)), nominatedClear);
  const clearedSet = new Set(cleared);
  const trimmed = union(prev.trimmed, pool.slice(0, level * MICRO_BATCH)).filter(
    (id) => !clearedSet.has(id),
  );

  return { state: { level, trimmed, cleared }, changed: true };
}

/**
 * Apply a micro-compaction state to the assembled message view. Content-only
 * and in-place; see `rewriteToolResults`.
 */
export function applyMicroToView(
  messages: Message[],
  state: MicroCompactionState,
  opts?: RewriteOpts,
): { messages: Message[]; cacheBreakpoint?: number } {
  if (state.level === 0) return { messages };
  return rewriteToolResults(messages, new Set(state.trimmed), new Set(state.cleared), opts);
}

/** Tolerant parse of a persisted state file — any corruption degrades to none. */
export function parseMicroState(raw: string): MicroCompactionState {
  try {
    const v = JSON.parse(raw) as Partial<MicroCompactionState>;
    const strings = (a: unknown): string[] =>
      Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : [];
    return {
      level: typeof v.level === 'number' && v.level > 0 ? Math.floor(v.level) : 0,
      trimmed: strings(v.trimmed),
      cleared: strings(v.cleared),
    };
  } catch {
    return DEFAULT_MICRO_STATE;
  }
}
