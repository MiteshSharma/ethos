import type {
  CompressionEvent,
  Message,
  PersonalityRegistry,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import type { SummarizerFn } from '../context-engines/semantic-summary';
import { estimateMessagesTokens, estimateTokens } from '../context-engines/token-estimator';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { droppedSkillNames, ghostSkillNotice, skillCallsFromHistory } from './ghost-skills';
import { dedupHistory, toLLMMessages } from './history';

// ---------------------------------------------------------------------------
// Phase 2 — compaction watermark. A compaction is no longer ephemeral: the
// applied summary + kept boundary are persisted to the `compressions` table and
// replayed into every subsequent turn's assembly, so the cooldown ships the
// COMPACTED view rather than raw history and `/compact` is not a one-turn
// illusion.
// ---------------------------------------------------------------------------

/** Newest stored messages kept verbatim after a compaction (auto + manual). */
export const COMPACTION_TAIL_KEEP = 6;
/**
 * Item 7 — newest USER messages the verbatim tail must contain. `tailKeep`
 * counts messages of any role, and a tool-heavy turn can fill all six with
 * assistant/tool_result rows — leaving the model with no verbatim record of
 * what it was actually asked. Overridable via `compaction.minTailUserMessages`.
 */
export const DEFAULT_MIN_TAIL_USER_MESSAGES = 3;
/** Token budget for a `/compact` summary — mirrors the semantic-summary default. */
export const MANUAL_SUMMARY_TARGET_TOKENS = 800;

/** Header prepended to a reconstructed compaction summary in the LLM history. */
export const WATERMARK_SUMMARY_PREFIX =
  '[Earlier conversation compacted — summary of older messages follows]';

export function renderWatermarkSummary(summaryText: string): string {
  return `${WATERMARK_SUMMARY_PREFIX}\n\n${summaryText}`;
}

/**
 * Pick the active compaction watermark from a session's compression history.
 * The most recent row carrying a `keptFromMessageId` boundary wins — earlier
 * watermarks are superseded. `listCompressions` returns rows oldest-first, so we
 * scan from the tail. Returns null when no row has a boundary.
 */
export function selectActiveWatermark(compressions: CompressionEvent[]): CompressionEvent | null {
  for (let i = compressions.length - 1; i >= 0; i--) {
    const row = compressions[i];
    if (row?.keptFromMessageId) return row;
  }
  return null;
}

/**
 * Choose the boundary that starts the verbatim tail: keep the newest `tailKeep`
 * stored messages. The boundary never starts on a `tool_result` (that would
 * orphan it from the tool_use in the summarized prefix), so it walks back to the
 * assistant message that owns the pending tool results.
 *
 * Item 7 — the tail must additionally contain at least `minUserMessages` user
 * messages: `tailKeep` counts rows of any role, so a tool-heavy tail can hold
 * zero user turns. The boundary is walked further back until enough user
 * messages are inside it (or history runs out). Both walks only ever move the
 * boundary EARLIER, so widening for user messages can never re-split a
 * tool_use/tool_result pair — and the tool_result walk-back runs last, so the
 * pair invariant holds for the final boundary either way.
 */
export function computeKeptTailBoundary(
  history: StoredMessage[],
  tailKeep: number,
  minUserMessages: number = DEFAULT_MIN_TAIL_USER_MESSAGES,
): { index: number; keptFromMessageId: string | undefined } {
  if (history.length === 0) return { index: 0, keptFromMessageId: undefined };
  let index = Math.max(0, history.length - Math.max(1, tailKeep));
  if (minUserMessages > 0) {
    let userCount = 0;
    for (let i = index; i < history.length; i++) {
      if (history[i]?.role === 'user') userCount++;
    }
    while (index > 0 && userCount < minUserMessages) {
      index--;
      if (history[index]?.role === 'user') userCount++;
    }
  }
  while (index > 0 && history[index]?.role === 'tool_result') index--;
  return { index, keptFromMessageId: history[index]?.id };
}

/** Options for {@link reconstructFromWatermark}. */
export interface ReconstructOpts {
  /**
   * Item 7 — emit a ghost-skill notice naming any skill whose `get_skill` body
   * is inside the dropped prefix. Set only for `skills.injection_mode: 'index'`
   * personalities; under `'full'` the body lives in the static prefix and is
   * never dropped.
   */
  skillMarkers?: boolean;
}

/**
 * Reconstruct the LLM-facing history from a persisted watermark. Everything
 * strictly older than the boundary is replaced by a single synthetic summary
 * message (when the watermark carries summary text) or dropped (engines that
 * don't summarize). The boundary and everything after it — including messages
 * appended on later turns — are kept verbatim.
 *
 * Item 7 — this is the one pruner that leaves NO trace by default: a dropped
 * `get_skill` result takes the skill's instructions with it while the index stub
 * in the system prompt still advertises the skill. With `skillMarkers` on, the
 * dropped names are carried into the synthetic message so the model knows to
 * re-load rather than confabulate.
 */
export function reconstructFromWatermark(
  history: StoredMessage[],
  watermark: CompressionEvent,
  opts?: ReconstructOpts,
): { history: StoredMessage[]; applied: boolean } {
  const boundaryId = watermark.keptFromMessageId;
  if (!boundaryId) return { history, applied: false };
  const idx = history.findIndex((m) => m.id === boundaryId);
  // idx === -1 → the boundary scrolled off the top of the window: every loaded
  // message is already in the kept region, so keep them all. idx > 0 → drop the
  // raw summarized prefix. idx === 0 → nothing older in the window to drop.
  const cut = idx > 0 ? idx : 0;
  const kept = history.slice(cut);
  const ghosts =
    opts?.skillMarkers && cut > 0
      ? droppedSkillNames(history.slice(0, cut), skillCallsFromHistory(history))
      : [];
  if (!watermark.summaryText) {
    // Drop-only watermark (e.g. drop_oldest): the drop survives via the boundary,
    // but there is no summary message to prepend — unless skill bodies went with
    // it, in which case the notice becomes the synthetic prefix message.
    if (ghosts.length === 0) return { history: kept, applied: cut > 0 };
    return {
      history: [syntheticPrefix(watermark, ghostSkillNotice(ghosts)), ...kept],
      applied: true,
    };
  }
  const summary = renderWatermarkSummary(watermark.summaryText);
  const content = ghosts.length > 0 ? `${summary}\n\n${ghostSkillNotice(ghosts)}` : summary;
  return { history: [syntheticPrefix(watermark, content), ...kept], applied: true };
}

/** The single synthetic assistant row that stands in for the dropped prefix. */
function syntheticPrefix(watermark: CompressionEvent, content: string): StoredMessage {
  return {
    id: `wm:${watermark.id}`,
    sessionId: watermark.sessionId,
    role: 'assistant',
    content,
    timestamp: watermark.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Manual /compact — forced compaction that bypasses the pressure gate.
// ---------------------------------------------------------------------------

export interface ManualCompactionDeps {
  session: SessionStore;
  /** Wired cheap-model summarizer. Absent → `drop_oldest` with an in-chat hint. */
  summarizer?: SummarizerFn;
  observability?: AgentLoopObservability;
}

export interface ManualCompactionArgs {
  sessionId: string;
  /** Replay history (raw window with any active watermark already applied). */
  history: StoredMessage[];
  /** Engine label recorded for audit (`semantic_summary` or `drop_oldest`). */
  engineName: string;
  /** Focus text from `/compact <focus…>`, threaded into the summarizer prompt. */
  instructions?: string;
  systemPrompt?: string;
  tailKeep: number;
  /** Item 7 — minimum USER messages inside the kept tail. Absent → default 3. */
  minTailUserMessages?: number;
  summaryTargetTokens: number;
}

export interface ManualCompactionResult {
  ok: boolean;
  /**
   * Why the compaction did not run. `personality_locked` mirrors the turn-setup
   * refusal code: the caller asked to compact as a personality the session is
   * not bound to.
   */
  reason?: 'too_short' | 'no_session' | 'personality_locked';
  engineName: string;
  droppedCount: number;
  summaryTokens: number;
  preTotalTokens: number;
  postTotalTokens: number;
  /** False when no summarizer is wired — the surface prints the enable hint. */
  summariesEnabled: boolean;
}

/**
 * Forced compaction for `/compact`. Summarizes the whole prefix (front + middle,
 * so the original task is not lost) when a summarizer is wired, otherwise drops
 * it. Persists a watermark so the compaction survives into later turns.
 */
export async function runManualCompaction(
  deps: ManualCompactionDeps,
  args: ManualCompactionArgs,
): Promise<ManualCompactionResult> {
  const summariesEnabled = deps.summarizer !== undefined;
  const { index, keptFromMessageId } = computeKeptTailBoundary(
    args.history,
    args.tailKeep,
    args.minTailUserMessages,
  );
  if (index <= 0 || !keptFromMessageId) {
    return {
      ok: false,
      reason: 'too_short',
      engineName: args.engineName,
      droppedCount: 0,
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      summariesEnabled,
    };
  }

  const prefix = args.history.slice(0, index);
  const tail = args.history.slice(index);
  const sys = args.systemPrompt ?? '';
  const preTotalTokens =
    estimateTokens(sys) + estimateMessagesTokens(toLLMMessages(dedupHistory(args.history)));

  const useSummary = summariesEnabled && args.engineName !== 'drop_oldest';
  let summaryText: string | undefined;
  const startedAt = Date.now();
  if (useSummary && deps.summarizer) {
    try {
      const prefixLLM = toLLMMessages(dedupHistory(prefix));
      summaryText = await deps.summarizer(prefixLLM, args.summaryTargetTokens, args.instructions);
    } catch (err) {
      // Fail-open: fall back to a drop-only compaction rather than aborting.
      deps.observability?.recordCompaction({
        severity: 'warn',
        code: 'context_engine_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
      summaryText = undefined;
    }
  }
  const durationMs = Date.now() - startedAt;
  const summaryTokens = summaryText ? estimateTokens(summaryText) : 0;

  const tailLLM = toLLMMessages(dedupHistory(tail));
  const postMessages: Message[] = summaryText
    ? [{ role: 'assistant', content: renderWatermarkSummary(summaryText) }, ...tailLLM]
    : tailLLM;
  const postTotalTokens = estimateTokens(sys) + estimateMessagesTokens(postMessages);
  const engineName = summaryText ? args.engineName : 'drop_oldest';

  try {
    await deps.session.recordCompression({
      sessionId: args.sessionId,
      engineName,
      originalCount: args.history.length,
      keptCount: tail.length + (summaryText ? 1 : 0),
      ...(summaryText !== undefined ? { summaryText } : {}),
      keptFromMessageId,
      summaryTokens,
      preTotalTokens,
      postTotalTokens,
      durationMs,
    });
    await deps.session.updateUsage(args.sessionId, { compactionCount: 1 });
  } catch (err) {
    deps.observability?.recordCompaction({
      severity: 'warn',
      code: 'compaction_persist_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  deps.observability?.recordCompaction({
    code: 'context_compacted',
    cause: `${engineName}: manual /compact`,
  });

  return {
    ok: true,
    engineName,
    droppedCount: prefix.length,
    summaryTokens,
    preTotalTokens,
    postTotalTokens,
    summariesEnabled,
  };
}

// ---------------------------------------------------------------------------
// compactSession — the `/compact` entry point used by AgentLoop.compact(). Kept
// out of agent-loop.ts so the orchestrator stays under its size guardrail.
// ---------------------------------------------------------------------------

export interface CompactSessionDeps {
  session: SessionStore;
  personalities: PersonalityRegistry;
  historyLimit: number;
  summarizer?: SummarizerFn;
  observability?: AgentLoopObservability;
  /** Item 7 — `compaction.minTailUserMessages`. Absent → default 3. */
  minTailUserMessages?: number;
}

/**
 * `opts.personalityId` is a FALLBACK, not an override: it applies only to a
 * legacy session row that was created before the personality-binding rule and
 * therefore carries no personality of its own. A bound session compacts as its
 * own personality, and a conflicting id is refused — see the comment on the
 * check below.
 */
export async function compactSession(
  deps: CompactSessionDeps,
  sessionKey: string,
  opts: { instructions?: string; personalityId?: string } = {},
): Promise<ManualCompactionResult> {
  const summariesEnabled = deps.summarizer !== undefined;
  const session = await deps.session.getSessionByKey(sessionKey);
  if (!session) {
    return {
      ok: false,
      reason: 'no_session',
      engineName: 'none',
      droppedCount: 0,
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      summariesEnabled,
    };
  }

  // A session's personality is bound at creation and never changes (see
  // `setupTurn`). Compaction is not a read-only view: the summary it writes
  // BECOMES this session's context on every later turn. Summarizing as some
  // other personality would therefore change what the session is, through the
  // back door the turn path already closed. Refuse the same way `setupTurn`
  // does rather than silently honouring the caller.
  if (session.personalityId && opts.personalityId && opts.personalityId !== session.personalityId) {
    return {
      ok: false,
      reason: 'personality_locked',
      engineName: 'none',
      droppedCount: 0,
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      summariesEnabled,
    };
  }

  const raw = (await deps.session.getMessages(session.id, { limit: deps.historyLimit })).filter(
    (m) => m.role !== 'system',
  );
  const active = selectActiveWatermark(await deps.session.listCompressions(session.id));
  const replay = active ? reconstructFromWatermark(raw, active).history : raw;

  const effectivePersonalityId = session.personalityId ?? opts.personalityId;
  const personality =
    (effectivePersonalityId ? deps.personalities.get(effectivePersonalityId) : null) ??
    deps.personalities.getDefault();
  const engineName = deps.summarizer
    ? (personality.context_engine ?? 'semantic_summary')
    : 'drop_oldest';

  return runManualCompaction(
    {
      session: deps.session,
      ...(deps.summarizer ? { summarizer: deps.summarizer } : {}),
      ...(deps.observability ? { observability: deps.observability } : {}),
    },
    {
      sessionId: session.id,
      history: replay,
      engineName,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      tailKeep: COMPACTION_TAIL_KEEP,
      ...(deps.minTailUserMessages !== undefined
        ? { minTailUserMessages: deps.minTailUserMessages }
        : {}),
      summaryTargetTokens: MANUAL_SUMMARY_TARGET_TOKENS,
    },
  );
}
