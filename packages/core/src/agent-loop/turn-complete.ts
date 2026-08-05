// Item 7 stage 2 — the framework call site for `ContextEngine.onTurnComplete`.
//
// Why here and not in the orchestrator: `agent-loop.ts` is at zero headroom
// against its size guardrail, and `turn-end.ts` has single-digit headroom, so
// the logic lives in this module and `maybeConsolidateAtTurnEnd` calls it in
// one line. Why at turn end at all: it is the only stage that runs AFTER the
// `done` event while the session lane is still held, so the engine sees a
// finished turn and cannot race the next inbound message.
//
// The call fires BEFORE turn-end's auto-compaction and memory-flush gates on
// purpose: `onTurnComplete` is a contract the engine holds with the framework,
// not a feature of the compaction config. An engine still hears about every
// turn in a deployment that sets `compaction.autoCompact: false` and leaves the
// memory flush off.
//
// `shouldCompact?()` is the cautionary precedent — declared, conformance-tested
// and never called. This module is what keeps `onTurnComplete` from becoming a
// second one.

import type {
  ContextEngine,
  ContextEngineStore,
  ContextEngineTurnCompleteOutput,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { evaluateGate } from './compaction';
import { dedupHistory, toLLMMessages } from './history';
import { reconstructFromWatermark, selectActiveWatermark } from './manual-compact';
import { advanceMicroState } from './micro-compaction';
import { loadMicroState, saveMicroState } from './micro-state';
import type { LoopDeps } from './turn-context';
import type { TurnEndCtx } from './turn-end';

/**
 * Resolve the engine a turn ran under. Same precedence as the pre-LLM gate
 * (`maybeCompact`): the personality's declared engine, else the per-model-class
 * default, else `drop_oldest` — with a registry fallback so an unknown name
 * cannot leave the hook unresolved.
 */
export function resolveTurnEngine(
  deps: Pick<LoopDeps, 'contextEngines' | 'compaction'>,
  personality: PersonalityConfig,
): ContextEngine | undefined {
  const name = personality.context_engine ?? deps.compaction?.defaultEngine ?? 'drop_oldest';
  return deps.contextEngines.get(name) ?? deps.contextEngines.get('drop_oldest');
}

/** Per-personality store handle, mirroring the one `maybeCompact` builds. */
function buildStore(deps: LoopDeps, personalityId: string): ContextEngineStore | undefined {
  const storage = deps.storage;
  const dataDir = deps.dataDir;
  if (!storage || !dataDir) return undefined;
  const basePath = `${dataDir}/compaction/${personalityId}`;
  return {
    read: (key) => storage.read(`${basePath}/${key}`),
    write: (key, value) => storage.write(`${basePath}/${key}`, value),
    list: () => storage.list(basePath),
  };
}

/**
 * Fire `ContextEngine.onTurnComplete` for the just-finished turn, then advance
 * and persist the micro-compaction state the next turn's assembly applies.
 *
 * Fail-open by construction: an engine that throws is recorded and ignored —
 * turn-end maintenance and the next turn proceed unchanged.
 *
 * Returns the engine's nominations (or `null`), so callers can act on them.
 */
export async function runTurnComplete(
  deps: LoopDeps,
  ctx: TurnEndCtx,
): Promise<ContextEngineTurnCompleteOutput | null> {
  const engine = resolveTurnEngine(deps, ctx.personality);
  // Micro-compaction needs somewhere to persist its state; without one it would
  // re-derive from scratch every turn, which is exactly the churn it exists to
  // avoid. Absent storage (tests, embedded hosts) → hook only.
  const microEnabled = deps.storage !== undefined && deps.dataDir !== undefined;
  // Neither a declared hook nor micro-compaction → no history load, no gate
  // arithmetic. Engines that do not implement the verb pay nothing for it.
  if (!engine?.onTurnComplete && !microEnabled) return null;

  const raw = (await deps.session.getMessages(ctx.sessionId, { limit: deps.historyLimit })).filter(
    (m) => m.role !== 'system',
  );
  if (raw.length === 0) return null;

  const active = selectActiveWatermark(await deps.session.listCompressions(ctx.sessionId));
  const replay = active ? reconstructFromWatermark(raw, active).history : raw;
  const messages = toLLMMessages(dedupHistory(replay));

  const gate = evaluateGate(
    {
      llm: deps.llm,
      ...(ctx.maxCompletionTokens !== undefined
        ? { reservedOutputTokens: ctx.maxCompletionTokens }
        : {}),
      ...(deps.compaction?.charsPerToken !== undefined
        ? { charsPerToken: deps.compaction.charsPerToken }
        : {}),
    },
    messages,
    ctx.systemPrompt,
  );
  const ratio = gate.window > 0 ? gate.current / gate.window : 0;

  let nomination: ContextEngineTurnCompleteOutput | null = null;
  if (engine?.onTurnComplete) {
    const store = buildStore(deps, ctx.personality.id);
    try {
      nomination = await engine.onTurnComplete({
        messages,
        currentSystem: ctx.systemPrompt,
        pressureRatio: ratio,
        personality: ctx.personality,
        sessionMetadata: {
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          turnNumber: ctx.turnNumber,
        },
        ...(store ? { store } : {}),
      });
      if (nomination?.notes) {
        deps.observability?.recordCompaction({
          code: 'context_engine_turn_complete',
          cause: `${engine.name}: ${nomination.notes}`,
        });
      }
    } catch (err) {
      nomination = null;
      deps.observability?.recordCompaction({
        severity: 'warn',
        code: 'context_engine_turn_complete_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (microEnabled) await advanceMicro(deps, ctx.sessionId, messages, ratio, nomination);
  return nomination;
}

/**
 * Advance and persist micro-compaction state. Writes only at a step crossing —
 * between crossings the state is unchanged, so there is nothing to write and
 * the next turn's assembly reapplies the identical set (cache-safe property 2).
 */
async function advanceMicro(
  deps: LoopDeps,
  sessionId: string,
  messages: Message[],
  ratio: number,
  nomination: ContextEngineTurnCompleteOutput | null,
): Promise<void> {
  const prev = await loadMicroState(deps.storage, deps.dataDir, sessionId);
  const advanced = advanceMicroState(prev, messages, ratio, nomination);
  if (!advanced.changed) return;
  await saveMicroState(deps.storage, deps.dataDir, sessionId, advanced.state);
  deps.observability?.recordCompaction({
    code: 'micro_compaction_step',
    cause: `level ${prev.level} → ${advanced.state.level}: ${advanced.state.trimmed.length} trimmed, ${advanced.state.cleared.length} cleared`,
  });
}
