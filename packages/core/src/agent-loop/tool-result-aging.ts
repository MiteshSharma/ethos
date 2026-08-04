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
 */
function preserveSpillPath(original: string, rewritten: string): string {
  const path = extractSpillPath(original);
  if (path === null || extractSpillPath(rewritten) !== null) return rewritten;
  return `${rewritten}\n[full output written to ${path} — use read_file to retrieve it]`;
}

/** Hard-clear replacement for one tool result, preserving any spill path. */
function hardClear(content: string): string {
  return preserveSpillPath(content, HARD_PLACEHOLDER);
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
 */
function oldToolUseIds(messages: Message[], keepRecentAssistantTurns: number): string[] {
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

/**
 * Apply an aging state to the assembled message view. Returns a new array with
 * aged tool_result content rewritten, plus the index of the last aged message
 * (a stable `cache_control` boundary) when anything was aged.
 */
export function applyAgingToView(
  messages: Message[],
  state: AgingState,
): { messages: Message[]; cacheBreakpoint?: number } {
  if (state.level === 'none' || (state.soft.length === 0 && state.hard.length === 0)) {
    return { messages };
  }
  const softSet = new Set(state.soft);
  const hardSet = new Set(state.hard);
  let lastAgedIdx = -1;

  const out = messages.map((m, idx) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result') return b;
      if (hardSet.has(b.tool_use_id)) {
        touched = true;
        return { ...b, content: hardClear(b.content) };
      }
      if (softSet.has(b.tool_use_id)) {
        const trimmed = softTrimContent(b.content);
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
