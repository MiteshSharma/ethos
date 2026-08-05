// Phase 1a — OpenClaw-style tool-result aging in the ASSEMBLED VIEW ONLY.
//
// As context pressure rises, old tool_results carry the least per-token signal
// (the agent already acted on them). This module soft-trims them (head+tail
// keep) once pressure crosses 0.3, then hard-clears them once it crosses 0.5 —
// but ONLY at those crossings, as one batched view change. Applying aging
// incrementally per turn would permanently invalidate the prompt cache, so the
// aged set is keyed by stable tool_use ids captured at the crossing and reused
// verbatim on every turn in between.
//
// Invariants:
//   • The on-disk transcript is NEVER touched — this rewrites only the LLM view.
//   • Aging edits tool_result CONTENT in place; it never removes or reorders a
//     message, so a tool_use / tool_result pair can never be split.

import type { Message, MessageContent } from '@ethosagent/types';
import { ghostSkillMarker } from './ghost-skills';

export type AgingLevel = 'none' | 'soft' | 'hard';

export interface AgingState {
  level: AgingLevel;
  /** tool_use ids whose results are soft-trimmed (head+tail keep). */
  soft: string[];
  /** tool_use ids whose results are hard-cleared to a placeholder. */
  hard: string[];
}

/** Context ratio (usage / window) at which soft-trimming begins. */
export const SOFT_RATIO = 0.3;
/** Context ratio at which old results are hard-cleared. */
export const HARD_RATIO = 0.5;
/** How many of the most-recent assistant turns are kept verbatim. */
export const KEEP_RECENT_ASSISTANT_TURNS = 3;
/** Chars kept at the head and at the tail of a soft-trimmed tool_result. */
export const SOFT_TRIM_KEEP_CHARS = 1_500;

/**
 * Lane 1(d) — quantized soft-trim buckets (the #111085 guard). Truncation
 * lengths for aged results come from these FIXED buckets, selected by the
 * result's age rank within the frozen soft set — NEVER from live budget
 * arithmetic. A length computed from the live budget jitters by a few chars
 * as the budget shifts, and a jitter near the top of the transcript forfeits
 * the prefix cache for the entire tail below it. Each value is the TOTAL
 * inline chars kept (head + tail together). Oldest results get the smallest
 * bucket: they carry the least per-token signal, and the newest aged results
 * are the likeliest to still be consulted.
 *
 * The TOP bucket is deliberately today's flat soft-trim total
 * (`SOFT_TRIM_KEEP_CHARS × 2`), not the plan's illustrative 8,192: a bucket
 * larger than the flat keep would let mid-sized results skip trimming that
 * fires today, WEAKENING aging — buckets may only quantize the trim harder,
 * never keep more than the pre-bucket behaviour did (the same never-scale-up
 * principle as Lane 1(e)'s cap-the-cap).
 */
export const SOFT_TRIM_BUCKETS_CHARS = [512, 2_048, SOFT_TRIM_KEEP_CHARS * 2] as const;

/**
 * The bucket (total kept chars) for age rank `rank` (0 = oldest) out of
 * `total` soft-aged results: oldest third → 512, middle third → 2,048,
 * newest third → 3,000. Pure and deterministic — the rank comes from the
 * frozen `AgingState.soft` order, so the assignment can never vary between
 * threshold crossings.
 */
export function bucketKeepChars(rank: number, total: number): number {
  const fallback = SOFT_TRIM_KEEP_CHARS * 2;
  if (total <= 0 || rank < 0 || rank >= total) return fallback;
  const share = rank / total;
  const idx = share < 1 / 3 ? 0 : share < 2 / 3 ? 1 : 2;
  return SOFT_TRIM_BUCKETS_CHARS[idx] ?? fallback;
}

/**
 * Per-id keep-chars (per side) for a state's soft set. `state.soft` preserves
 * the oldest-first order captured at the threshold crossing, and the state is
 * frozen between crossings — so the bucket assignment is frozen with it and
 * an aged result serializes byte-identically on every turn (#111085).
 */
export function softKeepMap(state: AgingState): Map<string, number> {
  const total = state.soft.length;
  return new Map(state.soft.map((id, i) => [id, Math.floor(bucketKeepChars(i, total) / 2)]));
}

const HARD_PLACEHOLDER =
  '[tool result cleared to reclaim context — re-run the tool if you need it again]';

/**
 * Item 7 — oversized tool output is spilled to a file and the inline result
 * keeps only head + tail plus a notice carrying the spill PATH (see
 * `extensions/tools-terminal/src/spill.ts`). The file survives for 24h, so
 * aging away the whole result would throw away a still-valid pointer to output
 * the agent can otherwise read back. Match on the notice's stable "full output
 * written to <path>" phrase — no import, this stays a string contract — and
 * carry the path through both aging levels.
 */
const SPILL_PATH_RE = /full output written to (.+?) — use read_file/;

/** The spill-file path inside a tool result, when it carries one. */
export function extractSpillPath(content: string): string | null {
  return SPILL_PATH_RE.exec(content)?.[1] ?? null;
}

/**
 * Re-attach the spill pointer when an aging rewrite dropped it. Both levels go
 * through here: hard-clear drops the whole result, and soft-trim drops the
 * middle — where the notice sits, since `spill.ts` places it at 60% of the
 * inline budget. Appending is skipped when the rewrite already carries a
 * pointer (notice landed in the kept head or tail), so a result can never end
 * up with two.
 *
 * Exported for the Lane 1(c) ingestion-time cap in stages/tool-processing.ts,
 * which truncates an over-budget result BEFORE persisting it and must honour
 * the same contract.
 */
export function preserveSpillPath(original: string, rewritten: string): string {
  const path = extractSpillPath(original);
  if (path === null || extractSpillPath(rewritten) !== null) return rewritten;
  return `${rewritten}\n[full output written to ${path} — use read_file to retrieve it]`;
}

/**
 * Hard-clear replacement for one tool result, preserving any spill path. When
 * the cleared result is a `get_skill` body (Item 7 ghost-skill defense), the
 * generic placeholder is replaced by one that NAMES the skill — the generic
 * text tells the model something was cleared, but not that a capability its
 * prompt still advertises has quietly stopped being loaded.
 */
function hardClear(content: string, skillName?: string): string {
  return preserveSpillPath(content, skillName ? ghostSkillMarker(skillName) : HARD_PLACEHOLDER);
}

export const DEFAULT_AGING_STATE: AgingState = { level: 'none', soft: [], hard: [] };

const LEVEL_RANK: Record<AgingLevel, number> = { none: 0, soft: 1, hard: 2 };

function maxLevel(a: AgingLevel, b: AgingLevel): AgingLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** The aging level pressure alone would ask for at this ratio. */
export function levelForRatio(ratio: number): AgingLevel {
  if (ratio >= HARD_RATIO) return 'hard';
  if (ratio >= SOFT_RATIO) return 'soft';
  return 'none';
}

/**
 * Soft-trim: keep the head and the tail, drop the middle. Short results are
 * returned unchanged so trimming never grows a string. A spill notice that fell
 * in the dropped middle is re-attached as a one-line pointer.
 */
export function softTrimContent(content: string, keepChars = SOFT_TRIM_KEEP_CHARS): string {
  const marker = (removed: number) => `\n\n…[${removed.toLocaleString()} chars trimmed]…\n\n`;
  // Only trim when doing so actually saves space (head + tail + marker < original).
  if (content.length <= keepChars * 2 + 64) return content;
  const head = content.slice(0, keepChars);
  const tail = content.slice(-keepChars);
  const removed = content.length - keepChars * 2;
  return preserveSpillPath(content, `${head}${marker(removed)}${tail}`);
}

/**
 * tool_use ids from assistant turns OLDER than the most-recent
 * `keepRecentAssistantTurns` tool-using turns. These are the aging candidates.
 *
 * Exported for micro-compaction (Item 7), which draws from the SAME candidate
 * pool in the same oldest-first order — one definition of "stale enough to
 * rewrite", not two that can drift apart.
 */
export function oldToolUseIds(messages: Message[], keepRecentAssistantTurns: number): string[] {
  const toolTurnIdx: number[] = [];
  messages.forEach((m, i) => {
    if (
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_use')
    ) {
      toolTurnIdx.push(i);
    }
  });
  const oldCount = toolTurnIdx.length - keepRecentAssistantTurns;
  if (oldCount <= 0) return [];
  const ids: string[] = [];
  for (const idx of toolTurnIdx.slice(0, oldCount)) {
    const content = messages[idx]?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b.type === 'tool_use') ids.push(b.id);
  }
  return ids;
}

/**
 * Advance the aging state given the current context ratio. The level is
 * monotonic (never downgrades — downgrading would re-invalidate the cache). The
 * aged id sets are recomputed ONLY when the level crosses a threshold; between
 * crossings the previous state is returned unchanged (`changed: false`).
 */
export function advanceAgingState(
  prev: AgingState,
  messages: Message[],
  ratio: number,
  opts?: { keepRecentAssistantTurns?: number },
): { state: AgingState; changed: boolean } {
  const level = maxLevel(prev.level, levelForRatio(ratio));
  if (level === prev.level) return { state: prev, changed: false };

  const keep = opts?.keepRecentAssistantTurns ?? KEEP_RECENT_ASSISTANT_TURNS;
  const old = oldToolUseIds(messages, keep);
  // Crossing to `soft`: all currently-old results are soft-trimmed. Crossing to
  // `hard`: everything old (including anything previously soft) is hard-cleared.
  const state: AgingState =
    level === 'hard'
      ? { level: 'hard', soft: [], hard: old }
      : { level: 'soft', soft: old, hard: [] };
  return { state, changed: true };
}

/** Options shared by every content-only tool_result rewrite. */
export interface RewriteOpts {
  /**
   * `tool_use_id` → skill name for `get_skill` results (Item 7 ghost-skill
   * defense). Absent / empty → generic placeholders, which is what
   * `injection_mode: 'full'` personalities get, since their skill bodies live
   * in the static prefix and are never pruned.
   */
  skillNames?: Map<string, string>;
  /**
   * Lane 1(d) — per-id keep-chars (per side) for soft trims, built from the
   * frozen state by {@link softKeepMap}. Ids not in the map (and callers that
   * pass none, e.g. micro-compaction) fall back to the flat
   * `SOFT_TRIM_KEEP_CHARS` default.
   */
  softKeepChars?: ReadonlyMap<string, number>;
}

/**
 * CONTENT-ONLY, IN-PLACE rewrite of the tool_result blocks named by `soft` and
 * `hard`. Shared by tool-result aging and Item 7 micro-compaction so there is
 * exactly one implementation of the invariant that matters: no message is ever
 * removed, added, or reordered, so a `tool_use` / `tool_result` pair can never
 * be split. Returns the index of the last rewritten message — a stable
 * `cache_control` boundary — when anything changed.
 */
export function rewriteToolResults(
  messages: Message[],
  soft: ReadonlySet<string>,
  hard: ReadonlySet<string>,
  opts?: RewriteOpts,
): { messages: Message[]; cacheBreakpoint?: number } {
  if (soft.size === 0 && hard.size === 0) return { messages };
  const skillNames = opts?.skillNames;
  let lastAgedIdx = -1;

  const out = messages.map((m, idx) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result') return b;
      if (hard.has(b.tool_use_id)) {
        touched = true;
        return { ...b, content: hardClear(b.content, skillNames?.get(b.tool_use_id)) };
      }
      if (soft.has(b.tool_use_id)) {
        const trimmed = softTrimContent(b.content, opts?.softKeepChars?.get(b.tool_use_id));
        if (trimmed !== b.content) {
          touched = true;
          return { ...b, content: trimmed };
        }
      }
      return b;
    });
    if (!touched) return m;
    lastAgedIdx = idx;
    return { ...m, content: content as MessageContent[] };
  });

  return lastAgedIdx >= 0 ? { messages: out, cacheBreakpoint: lastAgedIdx } : { messages: out };
}

/**
 * Apply an aging state to the assembled message view. Returns a new array with
 * aged tool_result content rewritten, plus the index of the last aged message
 * (a stable `cache_control` boundary) when anything was aged.
 */
export function applyAgingToView(
  messages: Message[],
  state: AgingState,
  opts?: RewriteOpts,
): { messages: Message[]; cacheBreakpoint?: number } {
  if (state.level === 'none') return { messages };
  // Lane 1(d) — soft-trim lengths come from quantized buckets keyed to the
  // frozen soft-set order, never from live budget arithmetic (#111085).
  const withBuckets: RewriteOpts | undefined =
    state.soft.length > 0 ? { ...opts, softKeepChars: softKeepMap(state) } : opts;
  return rewriteToolResults(messages, new Set(state.soft), new Set(state.hard), withBuckets);
}
