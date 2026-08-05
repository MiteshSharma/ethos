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
  PersonalityConfig,
} from '@ethosagent/types';
import { evaluateGate } from './compaction';
import { dedupHistory, toLLMMessages } from './history';
import { reconstructFromWatermark, selectActiveWatermark } from './manual-compact';
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
 * Fire `ContextEngine.onTurnComplete` for the just-finished turn.
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
  // No declared hook → no history load, no gate arithmetic. Engines that do not
  // implement the verb pay nothing for its existence.
  if (!engine?.onTurnComplete) return null;

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
  const store = buildStore(deps, ctx.personality.id);

  try {
    const result = await engine.onTurnComplete({
      messages,
      currentSystem: ctx.systemPrompt,
      pressureRatio: gate.window > 0 ? gate.current / gate.window : 0,
      personality: ctx.personality,
      sessionMetadata: {
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        turnNumber: ctx.turnNumber,
      },
      ...(store ? { store } : {}),
    });
    if (result?.notes) {
      deps.observability?.recordCompaction({
        code: 'context_engine_turn_complete',
        cause: `${engine.name}: ${result.notes}`,
      });
    }
    return result ?? null;
  } catch (err) {
    deps.observability?.recordCompaction({
      severity: 'warn',
      code: 'context_engine_turn_complete_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
