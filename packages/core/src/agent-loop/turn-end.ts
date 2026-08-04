import type {
  AgentEvent,
  Message,
  MessageContent,
  StoredMessage,
  ToolContext,
  ToolFilterOpts,
} from '@ethosagent/types';
import { handleChunk } from './chunk-handler';
import { effectiveGate, evaluateGate, gateThreshold } from './compaction';
import { dedupHistory, toLLMMessages } from './history';
import {
  COMPACTION_TAIL_KEEP,
  MANUAL_SUMMARY_TARGET_TOKENS,
  reconstructFromWatermark,
  runManualCompaction,
  selectActiveWatermark,
} from './manual-compact';
import type { LoopDeps, TurnSetup } from './turn-context';

// ---------------------------------------------------------------------------
// Phase 3 — turn-end context maintenance. Two triggers run as the FINAL stage
// of a turn (AFTER the `done` event, while the session lane is still held) so
// neither can race the next inbound message:
//
//   • memory flush (soft, default 70%): a silent, non-persisted agentic side-
//     call restricted to the memory tools. Every event it produces is internal
//     — nothing reaches the surface. It consolidates durable facts into MEMORY/
//     USER before compaction later drops raw history. Fail-open; aborts on any
//     inbound user message; timeboxed + token-capped; memory-delta capped.
//
//   • auto-compaction (hard, default 80%): persists a compaction watermark for
//     the NEXT turn and emits a one-line user-visible notice. Reuses the manual
//     `/compact` machinery so there is exactly one compaction writer.
//
// Auto-compaction is default ON (`compaction.autoCompact: false` disables it);
// the memory flush stays opt-in. Both share the compaction cooldown.
// ---------------------------------------------------------------------------

const COMPACTION_COOLDOWN_TURNS = 5;
const DEFAULT_COMPACT_PRESSURE = 0.8;
const DEFAULT_FLUSH_THRESHOLD = 0.7;
const DEFAULT_FLUSH_TIMEBOX_MS = 30_000;
const DEFAULT_FLUSH_MAX_TOKENS = 1_024;
const DEFAULT_FLUSH_MAX_DELTA_CHARS = 4_000;
const DEFAULT_MIN_MESSAGES_SINCE_FLUSH = 8;
const FLUSH_MAX_ITERATIONS = 3;
/** Restricted toolset for the flush turn — memory tools ONLY. */
const FLUSH_TOOLSET = ['memory_write', 'memory_read'];

const FLUSH_SYSTEM_PROMPT =
  'You are performing silent background memory maintenance between turns. ' +
  'Review the conversation so far and record only durable, reusable facts: ' +
  'project context and decisions into MEMORY.md (store="memory"), and stable ' +
  'user preferences into USER.md (store="user"), using the memory_write tool. ' +
  'Read current memory first if useful to avoid duplicates. Be terse — a few ' +
  'high-signal lines, not a transcript. Do not converse. When there is nothing ' +
  'worth saving, stop without writing.';

const FLUSH_INSTRUCTION =
  'Consolidate any durable facts from this conversation into memory now, then stop.';

export interface TurnEndCtx {
  sessionId: string;
  sessionKey: string;
  personality: import('@ethosagent/types').PersonalityConfig;
  turnNumber: number;
  lastCompactionTurn: number;
  memScopeId: string;
  userScopeId: string | undefined;
  filterOpts: ToolFilterOpts;
  /** A compaction already fired during this turn's assembly. */
  compactedThisTurn: boolean;
  /**
   * The run's abort signal (from `RunOptions.abortSignal`). The SAME signal that
   * aborts the main turn also aborts an in-flight memory flush — in the CLI it is
   * `state.abort.signal`, tripped on SIGINT and on interrupt-mode busy input (see
   * apps/ethos/src/commands/chat.ts); `runMemoryFlush` folds it into an
   * `AbortSignal.any` with the internal timebox deadline.
   */
  abortSignal: AbortSignal;
  /** The assembled system prompt for the just-finished turn — fed to the pressure
   *  gate so first-turn/legacy paths (no measured static tokens) don't understate
   *  pressure by treating the system+tools overhead as zero. */
  systemPrompt: string;
  /** Output reserve for the pressure gate (from RunOptions.maxCompletionTokens). */
  maxCompletionTokens?: number;
}

/** Extra loop-local fields the turn-end stage needs beyond `TurnSetup`. */
export interface TurnEndExtras {
  userScopeId: string | undefined;
  compactedThisTurn: boolean;
  abortSignal: AbortSignal;
  systemPrompt: string;
  maxCompletionTokens?: number;
}

/** Build a {@link TurnEndCtx} from the shared `TurnSetup` plus loop-locals so
 *  the orchestrator's call site stays a single line. */
export function buildTurnEndCtx(setup: TurnSetup, extras: TurnEndExtras): TurnEndCtx {
  return {
    sessionId: setup.sessionId,
    sessionKey: setup.sessionKey,
    personality: setup.personality,
    turnNumber: setup.turnNumber,
    lastCompactionTurn: setup.lastCompactionTurn,
    memScopeId: setup.memScopeId,
    filterOpts: setup.filterOpts,
    userScopeId: extras.userScopeId,
    compactedThisTurn: extras.compactedThisTurn,
    abortSignal: extras.abortSignal,
    systemPrompt: extras.systemPrompt,
    ...(extras.maxCompletionTokens !== undefined
      ? { maxCompletionTokens: extras.maxCompletionTokens }
      : {}),
  };
}

interface FlushState {
  lastFlushTurn: number;
  lastFlushMessageCount: number;
}

const DEFAULT_FLUSH_STATE: FlushState = { lastFlushTurn: 0, lastFlushMessageCount: 0 };

function flushStatePath(dataDir: string, sessionId: string): string {
  return `${dataDir}/flush/${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

async function loadFlushState(
  storage: LoopDeps['storage'],
  dataDir: string | undefined,
  sessionId: string,
): Promise<FlushState> {
  if (!storage || !dataDir) return DEFAULT_FLUSH_STATE;
  try {
    const raw = await storage.read(flushStatePath(dataDir, sessionId));
    if (!raw) return DEFAULT_FLUSH_STATE;
    const v = JSON.parse(raw) as Partial<FlushState>;
    return {
      lastFlushTurn: typeof v.lastFlushTurn === 'number' ? v.lastFlushTurn : 0,
      lastFlushMessageCount:
        typeof v.lastFlushMessageCount === 'number' ? v.lastFlushMessageCount : 0,
    };
  } catch {
    return DEFAULT_FLUSH_STATE;
  }
}

async function saveFlushState(
  storage: LoopDeps['storage'],
  dataDir: string | undefined,
  sessionId: string,
  state: FlushState,
): Promise<void> {
  if (!storage || !dataDir) return;
  try {
    await storage.mkdir(`${dataDir}/flush`);
    await storage.writeAtomic(flushStatePath(dataDir, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort — a miss just re-evaluates the trivial-delta guard next turn.
  }
}

/** Derive the previous turn's real input + static (system+tools) tokens from the
 *  freshest assistant message usage — the actuals-first gate signal (Phase 0). */
function deriveActuals(raw: StoredMessage[]): {
  lastActualInputTokens?: number;
  staticTokens?: number;
} {
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i];
    if (m?.role === 'assistant' && m.usage?.inputTokens) {
      const rt = m.usage.requestTokens;
      return {
        lastActualInputTokens: m.usage.inputTokens,
        ...(rt ? { staticTokens: rt.system + rt.tools } : {}),
      };
    }
  }
  return {};
}

/**
 * Turn-end context maintenance. Yields ONLY the user-visible compaction notice;
 * the memory flush yields nothing (internal-only by construction).
 */
export async function* maybeConsolidateAtTurnEnd(
  deps: LoopDeps,
  ctx: TurnEndCtx,
): AsyncGenerator<AgentEvent> {
  // Context-economy Phase 2 — autoCompact is default ON (eval-gated flip);
  // only an explicit `autoCompact: false` disables the turn-end trigger.
  const autoCompact = deps.compaction?.autoCompact !== false;
  const flushEnabled = deps.memoryConsolidation?.enabled === true;
  if (!autoCompact && !flushEnabled) return;
  if (ctx.abortSignal.aborted) return;

  // Shared cooldown: skip if a compaction fired this turn or within the window.
  if (ctx.compactedThisTurn) return;
  const inCooldown =
    ctx.lastCompactionTurn > 0 &&
    ctx.turnNumber - ctx.lastCompactionTurn < COMPACTION_COOLDOWN_TURNS;
  if (inCooldown) return;

  const raw = (await deps.session.getMessages(ctx.sessionId, { limit: deps.historyLimit })).filter(
    (m) => m.role !== 'system',
  );
  if (raw.length === 0) return;

  const { lastActualInputTokens, staticTokens } = deriveActuals(raw);
  const active = selectActiveWatermark(await deps.session.listCompressions(ctx.sessionId));
  const replay = active ? reconstructFromWatermark(raw, active).history : raw;
  const llmMessages = toLLMMessages(dedupHistory(replay));

  const gateEval = evaluateGate(
    {
      llm: deps.llm,
      ...(ctx.maxCompletionTokens !== undefined
        ? { reservedOutputTokens: ctx.maxCompletionTokens }
        : {}),
      ...(deps.compaction?.charsPerToken !== undefined
        ? { charsPerToken: deps.compaction.charsPerToken }
        : {}),
      ...(deps.compaction?.gateDelta !== undefined ? { gateDelta: deps.compaction.gateDelta } : {}),
      ...(lastActualInputTokens !== undefined ? { lastActualInputTokens } : {}),
      ...(staticTokens !== undefined ? { staticTokens } : {}),
    },
    llmMessages,
    // Feed the real assembled system prompt (matching the pre-LLM `maybeCompact`
    // path) so first-turn / legacy-provider turns — which carry no measured
    // static-token count — still account for the system+tools overhead instead
    // of understating pressure with an empty string.
    ctx.systemPrompt,
  );

  // Item 7 — the absolute ceiling applies here too, not only at the pre-LLM
  // gate. The flush gate stays purely fractional: it is a soft consolidation
  // threshold, and compaction already takes precedence when both trip.
  const compactGate = effectiveGate(
    gateEval,
    deps.compaction?.pressure ?? DEFAULT_COMPACT_PRESSURE,
    deps.compaction?.maxContextTokens,
  );
  const flushGate = gateThreshold(
    gateEval,
    deps.memoryConsolidation?.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD,
  );

  // Auto-compaction (80%) takes precedence — once we're that high, dropping
  // history matters more than one more memory pass.
  if (autoCompact && gateEval.current > compactGate) {
    yield* compactAtTurnEnd(deps, ctx, replay);
    return;
  }
  if (flushEnabled && gateEval.current > flushGate) {
    await runMemoryFlush(deps, ctx, llmMessages, raw.length);
  }
}

/** Persist a compaction watermark for the next turn and emit a user notice.
 *  Reuses the manual-compact writer so there is one compaction persistence path. */
async function* compactAtTurnEnd(
  deps: LoopDeps,
  ctx: TurnEndCtx,
  replay: StoredMessage[],
): AsyncGenerator<AgentEvent> {
  const summarizer = deps.llmHandle?.summarize;
  const engineName =
    ctx.personality.context_engine ??
    deps.compaction?.defaultEngine ??
    (summarizer ? 'semantic_summary' : 'drop_oldest');

  const result = await runManualCompaction(
    {
      session: deps.session,
      ...(summarizer ? { summarizer } : {}),
      ...(deps.observability ? { observability: deps.observability } : {}),
    },
    {
      sessionId: ctx.sessionId,
      history: replay,
      engineName,
      tailKeep: COMPACTION_TAIL_KEEP,
      ...(deps.compaction?.minTailUserMessages !== undefined
        ? { minTailUserMessages: deps.compaction.minTailUserMessages }
        : {}),
      summaryTargetTokens: MANUAL_SUMMARY_TARGET_TOKENS,
    },
  );

  if (!result.ok || result.droppedCount === 0) return;

  // Mark the cooldown so the next turn's pre-LLM gate does not re-compact.
  try {
    await deps.session.recordCompactionTurn(ctx.sessionId, ctx.turnNumber);
  } catch {
    // Best-effort — a miss just means the next turn re-evaluates the gate.
  }

  const tok = result.summaryTokens > 0 ? `, ${result.summaryTokens} tok` : '';
  yield {
    type: 'tool_progress',
    toolName: '_compaction',
    message: `compressed ${result.droppedCount} earlier message(s) at turn end (${result.engineName}${tok})`,
    audience: 'user',
  };
}

export interface FlushResult {
  flushed: boolean;
  deltaChars: number;
  error?: string;
}

/**
 * Silent, non-persisted memory-flush turn. Drives the LLM with the memory tools
 * ONLY, executes its `memory_write`/`memory_read` calls against the wired memory
 * provider, and writes NOTHING to session history. All events are swallowed —
 * nothing user-visible. Fail-open, timeboxed, token- and delta-capped, and
 * aborts the moment an inbound user message trips `ctx.abortSignal`.
 */
export async function runMemoryFlush(
  deps: LoopDeps,
  ctx: TurnEndCtx,
  llmMessages: Message[],
  messageCount: number,
): Promise<FlushResult> {
  const mc = deps.memoryConsolidation ?? {};

  // Trivial-delta skip: only flush when enough NEW messages accumulated since
  // the last flush. Shares intent with the compaction cooldown (avoid churn).
  const state = await loadFlushState(deps.storage, deps.dataDir, ctx.sessionId);
  const minDelta = mc.minMessagesSinceFlush ?? DEFAULT_MIN_MESSAGES_SINCE_FLUSH;
  if (messageCount - state.lastFlushMessageCount < minDelta) {
    return { flushed: false, deltaChars: 0 };
  }

  // INTERSECT the flush toolset with the personality's own toolset — never UNION.
  // A personality that intentionally excludes memory tools (read-only, data-
  // classification, team-memory cross-visibility) must not have them handed back
  // through the flush. An unrestricted toolset (undefined) keeps the full set; an
  // empty intersection means the personality opted out → skip the flush entirely.
  const personalityToolset = ctx.personality.toolset;
  const flushToolset = personalityToolset
    ? FLUSH_TOOLSET.filter((name) => personalityToolset.includes(name))
    : FLUSH_TOOLSET;
  if (flushToolset.length === 0) return { flushed: false, deltaChars: 0 };

  const memWrite = deps.tools.get('memory_write');
  const memRead = deps.tools.get('memory_read');
  const toolDefs = deps.tools.toDefinitions(flushToolset, ctx.filterOpts);
  if (!memWrite || toolDefs.length === 0) return { flushed: false, deltaChars: 0 };

  const timeboxMs = mc.timeboxMs ?? DEFAULT_FLUSH_TIMEBOX_MS;
  const maxTokens = mc.maxTokens ?? DEFAULT_FLUSH_MAX_TOKENS;
  const maxDeltaChars = mc.maxDeltaChars ?? DEFAULT_FLUSH_MAX_DELTA_CHARS;

  // Hard timebox: an internal deadline combined with the run's abort signal so
  // an inbound user message (which aborts the run) also aborts the flush.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeboxMs);
  timer.unref?.();
  const signal = AbortSignal.any([ctx.abortSignal, deadline.signal]);

  const toolCtx: ToolContext = {
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: deps.platform,
    workingDir: deps.workingDir,
    personalityId: ctx.personality.id,
    memoryScopeId: ctx.memScopeId,
    ...(ctx.userScopeId ? { userScopeId: ctx.userScopeId } : {}),
    ...(deps.teamId !== undefined ? { teamId: deps.teamId } : {}),
    currentTurn: 0,
    messageCount,
    abortSignal: signal,
    // Internal audience by construction — swallow every progress event.
    emit: () => {},
    resultBudgetChars: 20_000,
  };

  const messages: Message[] = [...llmMessages, { role: 'user', content: FLUSH_INSTRUCTION }];
  let deltaChars = 0;

  try {
    for (let i = 0; i < FLUSH_MAX_ITERATIONS; i++) {
      if (signal.aborted) break;
      const pending: Array<{
        toolCallId: string;
        toolName: string;
        partialJson: string;
        args?: unknown;
        parseError?: string;
        repair?: { outcome: 'repaired' | 'failed' };
      }> = [];
      let text = '';
      const stream = deps.llm.complete(messages, toolDefs, {
        system: FLUSH_SYSTEM_PROMPT,
        maxTokens,
        abortSignal: signal,
      });
      for await (const chunk of stream) {
        if (signal.aborted) break;
        // Drain the generator — every event is internal; none is surfaced.
        for (const _event of handleChunk(chunk, pending, (t) => {
          text += t;
        })) {
          // intentionally swallowed
        }
      }
      if (signal.aborted) break;

      const calls = pending.filter((tc) => tc.args !== undefined);
      if (calls.length === 0) break; // model finished (text-only) → done

      const assistantContent: MessageContent[] = [];
      if (text) assistantContent.push({ type: 'text', text });
      for (const tc of calls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.args ?? {},
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      const results: MessageContent[] = [];
      for (const tc of calls) {
        if (signal.aborted) break;
        let resultText: string;
        let isError = false;
        if (tc.toolName === 'memory_read' && memRead) {
          const r = await memRead.execute(tc.args, toolCtx);
          resultText = r.ok ? r.value : r.error;
          isError = !r.ok;
        } else if (tc.toolName === 'memory_write') {
          const args = tc.args as { content?: unknown };
          const contentLen = typeof args?.content === 'string' ? args.content.length : 0;
          if (deltaChars + contentLen > maxDeltaChars) {
            resultText = 'memory-flush delta cap reached — no further writes this flush';
            isError = true;
          } else {
            const r = await memWrite.execute(tc.args, toolCtx);
            resultText = r.ok ? r.value : r.error;
            isError = !r.ok;
            if (r.ok) deltaChars += contentLen;
          }
        } else {
          // Defense in depth: the model can only see memory tools, but reject
          // anything else outright so the flush stays restricted.
          resultText = `tool "${tc.toolName}" is not available during memory flush`;
          isError = true;
        }
        results.push({
          type: 'tool_result',
          tool_use_id: tc.toolCallId,
          content: resultText,
          is_error: isError,
        });
      }
      messages.push({ role: 'user', content: results });
      if (deltaChars >= maxDeltaChars) break;
    }
    return { flushed: deltaChars > 0, deltaChars };
  } catch (err) {
    // Fail-open: a flush failure must never break the turn it runs after.
    deps.observability?.recordCompaction({
      severity: 'warn',
      code: 'memory_flush_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
    return { flushed: false, deltaChars, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    // Advance the trivial-delta guard on a NATURAL completion (a no-op flush that
    // wrote nothing still counts, so we don't re-run every subsequent turn while
    // pressure sits between the flush and compact thresholds). But when the flush
    // was ABORTED before doing any work (inbound user message or timebox) we do
    // NOT advance — otherwise the next turn's trivial-delta guard would skip a
    // legitimate flush window for ~minDelta more messages, starving consolidation
    // under frequent inbound aborts.
    if (deltaChars > 0 || !signal.aborted) {
      await saveFlushState(deps.storage, deps.dataDir, ctx.sessionId, {
        lastFlushTurn: ctx.turnNumber,
        lastFlushMessageCount: messageCount,
      });
    }
  }
}
