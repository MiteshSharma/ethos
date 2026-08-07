import type {
  AgentEvent,
  Attachment,
  HookRegistry,
  ScriptToolCallResult,
  ScriptToolExecution,
  ScriptToolsApi,
  ToolContext,
  ToolFilterOpts,
  ToolRegistry,
} from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { scriptCallableFor, scriptExclusionError, scriptExclusionFor } from '../../script-safe';
import type { checkTurnBudgets } from '../budgets';
import type { WatcherTap } from '../turn-context';
import {
  consultWatcherHalt,
  enforceBeforeToolCall,
  recordToolCallForBudgets,
  type TurnBudgetCounters,
} from './per-call-enforcement';

// ---------------------------------------------------------------------------
// ScriptToolBridge — second enforcement of the same contract (tools-as-code-api
// Lane B). Constructed once per user turn by AgentLoop; threaded to tools via
// the optional `ToolContext.scriptTools` seam. Each in-script RPC call
// traverses, in order: the script-callable surface (Lane C), the single
// `before_tool_call` fire site, the watcher tap, the SHARED turn budget
// counters, and finally `executeParallel` with the turn's filterOpts and a
// script-scoped result budget (Lane D) — one contract, no bypass lane.
// ---------------------------------------------------------------------------

/** Lane D — tool calls per script execution (bridge-internal constant, not config). */
export const SCRIPT_CALLS_PER_EXECUTION = 50;

/**
 * Lane D — per-call result budget for results delivered to the SCRIPT (they
 * never enter the LLM context, so the turn split is the wrong throttle). The
 * effective cap per call is `min(this, tool.maxResultChars ?? this)` via
 * `executeParallel`'s existing arithmetic.
 */
export const SCRIPT_RESULT_BUDGET_CHARS = 262_144;

export interface ScriptToolBridgeDeps {
  tools: ToolRegistry;
  hooks: HookRegistry;
  observability?: AgentLoopObservability;
  sessionId: string;
  traceId: string | undefined;
  /** The turn's effective toolset allowlist from turn-setup (undefined = unrestricted). */
  allowedTools: string[] | undefined;
  allowedPlugins: string[];
  filterOpts: ToolFilterOpts;
  /** Read `.getHalt()` live — dangerous-mode neutralization reassigns it. */
  watcherTap: WatcherTap;
  /** The SAME mutable counters the loop's budget guard reads (never a copy). */
  counters: TurnBudgetCounters;
  /**
   * The loop's budget check with the loop's own arguments (caps, live session
   * spend, denial streak) — one closure so the bridge fails a call with
   * exactly the message the loop halts with.
   */
  checkBudgets: () => ReturnType<typeof checkTurnBudgets>;
  /** The turn's inbound attachments, forwarded so the registry's live ctx stays stable. */
  turnAttachments?: Attachment[];
  /**
   * Lane E — the loop's per-tool metric callback (AgentLoopConfig.onToolMetric),
   * fired per inner call under the SAME gate as the batch path (plugin-tagged
   * tools only — the diagnostic store is keyed by pluginId). Plugin tools are
   * excluded from the v1 script surface, so this is future-proofing: if
   * SCRIPT_SAFE ever admits them, their metrics will not silently go missing.
   */
  onToolMetric?: (opts: {
    pluginId: string;
    toolName: string;
    ok: boolean;
    durationMs: number;
    sessionId: string;
    turnId: string;
  }) => void;
}

/** Lane E — emit sink for inner-call `tool_start`/`tool_end` AgentEvents. */
export type ScriptEventSink = (event: AgentEvent) => void;

export class ScriptToolBridge {
  private readonly callable: string[];
  private readonly callableSet: Set<string>;
  private execSeq = 0;

  constructor(private readonly deps: ScriptToolBridgeDeps) {
    // Lane C — the script-callable surface, computed ONCE per turn from the
    // same derivation the character sheet renders (Lane G).
    this.callable = scriptCallableFor(
      deps.allowedTools ? { toolset: deps.allowedTools } : {},
      deps.tools,
    );
    this.callableSet = new Set(this.callable);
  }

  /**
   * Bind this turn's bridge to one tool batch's ToolContext. `getCtx` is read
   * lazily per call so the bridge sees the fully-built context (including the
   * `scriptTools` field that points back at this bridge). `emitEvent` (Lane E)
   * is the batch's live event queue: inner calls emit real `tool_start`/
   * `tool_end` AgentEvents with `audience: 'internal'` through it. Absent
   * (hand-built test contexts) → no events, enforcement unchanged.
   */
  bind(getCtx: () => ToolContext, emitEvent?: ScriptEventSink): ScriptToolsApi {
    return {
      callableTools: () => [...this.callable],
      startExecution: (opts) => this.startExecution(getCtx, emitEvent, opts),
    };
  }

  private startExecution(
    getCtx: () => ToolContext,
    emitEvent: ScriptEventSink | undefined,
    opts?: { onAbortExecution?: (reason: string) => void; parentToolCallId?: string },
  ): ScriptToolExecution {
    let execCalls = 0;
    let abortedReason: string | null = null;
    // Lane E — inner toolCallIds are namespaced `<parentToolCallId>#<n>` so a
    // transcript reader can reconstruct the tree. When the caller cannot know
    // its own id (a hand-built ToolContext without `toolCallId`), fall back to
    // a deterministic per-execution namespace unique within the turn.
    const namespace = opts?.parentToolCallId ?? `script:${++this.execSeq}`;
    const abortExecution = (reason: string): void => {
      if (abortedReason === null) {
        abortedReason = reason;
        opts?.onAbortExecution?.(reason);
      }
    };
    return {
      call: async (name, args) => {
        if (abortedReason !== null) {
          return { ok: false, error: abortedReason, code: 'execution_aborted' };
        }
        // Lane D — per-execution cap. Fails the CALL, not the container: the
        // script can still print and exit.
        execCalls++;
        if (execCalls > SCRIPT_CALLS_PER_EXECUTION) {
          return {
            ok: false,
            error:
              `Per-execution tool-call cap reached: at most ${SCRIPT_CALLS_PER_EXECUTION} ` +
              'tool calls per script execution. Aggregate more per call or print what you have.',
            code: 'per_execution_cap',
          };
        }
        return this.dispatch(
          getCtx,
          emitEvent,
          abortExecution,
          `${namespace}#${execCalls}`,
          name,
          args,
        );
      },
    };
  }

  private async dispatch(
    getCtx: () => ToolContext,
    emitEvent: ScriptEventSink | undefined,
    abortExecution: (reason: string) => void,
    toolCallId: string,
    name: string,
    args: unknown,
  ): Promise<ScriptToolCallResult> {
    const d = this.deps;
    const scriptCtx = (): ToolContext => ({
      ...getCtx(),
      resultBudgetChars: SCRIPT_RESULT_BUDGET_CHARS,
    });

    // Step 1 — the script-callable surface. Exclusions name their category;
    // anything else outside the surface is delegated to executeParallel with
    // the surface as the allowlist, so out-of-toolset / unknown / unavailable
    // tools get the registry's own error text (string-equal with the LLM path)
    // and nothing outside the surface can ever execute.
    if (!this.callableSet.has(name)) {
      const tool = d.tools.get(name);
      const pluginId = d.tools.getPluginId?.(name);
      const exclusion = scriptExclusionFor(name, { toolset: tool?.toolset, pluginId });
      if (exclusion !== null) {
        return { ok: false, error: scriptExclusionError(name, exclusion), code: 'not_available' };
      }
      const startedAt = Date.now();
      emitEvent?.({ type: 'tool_start', toolCallId, toolName: name, args, audience: 'internal' });
      const [rejected] = await d.tools.executeParallel(
        [{ toolCallId, name, args }],
        scriptCtx(),
        this.callable,
        d.filterOpts,
        d.turnAttachments,
      );
      const rejection = rejected?.result ?? {
        ok: false as const,
        error: 'Tool result missing',
        code: 'execution_failed' as const,
      };
      emitEvent?.({
        type: 'tool_end',
        toolCallId,
        toolName: name,
        ok: rejection.ok,
        durationMs: Date.now() - startedAt,
        audience: 'internal',
        ...(rejection.ok ? {} : { error: rejection.error }),
      });
      return toCallResult(rejection);
    }

    // Step 2 — the single production `before_tool_call` fire site. A rejection
    // returns {ok:false} to the script; NO tool_result persistence — inner
    // calls never appear as tool_use blocks, so the Anthropic contract binds
    // nothing here.
    const decision = await enforceBeforeToolCall(
      { hooks: d.hooks, observability: d.observability },
      {
        sessionId: d.sessionId,
        toolCallId,
        toolName: name,
        args,
        allowedPlugins: d.allowedPlugins,
        traceId: d.traceId,
      },
    );
    if (!decision.allowed) {
      // Parity with the batch path's emitToolRejection: a hook-blocked call
      // gets a terminal tool_end (no tool_start — it never reached execution).
      emitEvent?.({
        type: 'tool_end',
        toolCallId,
        toolName: name,
        ok: false,
        durationMs: 0,
        audience: 'internal',
        error: decision.reason,
      });
      return { ok: false, error: decision.reason, code: 'tool_blocked' };
    }
    const effectiveArgs = decision.effectiveArgs;

    // Step 3 — watcher tap. A pause/terminate halt fails the call AND aborts
    // the whole execution: the script cannot outlive a watcher halt.
    const preHalt = consultWatcherHalt(d.watcherTap.getHalt);
    if (preHalt.halted) {
      abortExecution(preHalt.rejectionReason);
      return { ok: false, error: preHalt.rejectionReason, code: 'watcher_halt' };
    }

    // Step 4 — the SAME turn budget counters and the SAME check the loop runs
    // at its iteration boundary. A script that makes 60 calls has made 60
    // calls; when the cap is crossed the bridge fails the call with the exact
    // message the loop's `halt` carries (and the loop halts after run_code
    // returns, because the counters are shared).
    const budget = d.checkBudgets();
    if (budget.exceeded) {
      return { ok: false, error: budget.message, code: `turn_budget:${budget.rule}` };
    }
    recordToolCallForBudgets(d.counters, name, effectiveArgs);

    // Watcher observes inner calls exactly like batch calls, so invocation-
    // counting rules trip mid-script.
    d.watcherTap.observe({ type: 'tool_start', toolName: name, args: effectiveArgs });
    const startHalt = consultWatcherHalt(d.watcherTap.getHalt);
    if (startHalt.halted) {
      abortExecution(startHalt.rejectionReason);
      return { ok: false, error: startHalt.rejectionReason, code: 'watcher_halt' };
    }

    // Step 5 — execute through the registry pipeline (allowlist again,
    // isAvailable, capability gates, invocation filters, post-trim) with the
    // script-scoped result budget (Lane D — NOT the turn split). Lane E: real
    // tool_start/tool_end events, tagged 'internal' so surfaces skip them
    // while logs/telemetry/dev surfaces see the full tree. The result body is
    // deliberately NOT copied onto the internal tool_end — inner results (up
    // to 256 KB) belong to the script, not the event stream.
    const startedAt = Date.now();
    emitEvent?.({
      type: 'tool_start',
      toolCallId,
      toolName: name,
      args: effectiveArgs,
      audience: 'internal',
    });
    const [executed] = await d.tools.executeParallel(
      [{ toolCallId, name, args: effectiveArgs }],
      scriptCtx(),
      this.callable,
      d.filterOpts,
      d.turnAttachments,
    );
    const result = executed?.result ?? {
      ok: false as const,
      error: 'Tool result missing',
      code: 'execution_failed' as const,
    };
    const durationMs = Date.now() - startedAt;
    emitEvent?.({
      type: 'tool_end',
      toolCallId,
      toolName: name,
      ok: result.ok,
      durationMs,
      audience: 'internal',
      ...(result.ok ? {} : { error: result.error }),
    });
    // Lane E — per-inner-call metric, same pluginId gate as the batch path.
    if (d.onToolMetric) {
      const metricPluginId = d.tools.getPluginId?.(name);
      if (metricPluginId) {
        d.onToolMetric({
          pluginId: metricPluginId,
          toolName: name,
          ok: result.ok,
          durationMs,
          sessionId: d.sessionId,
          turnId: String(getCtx().currentTurn),
        });
      }
    }
    d.watcherTap.observe({ type: 'tool_end', toolName: name, ok: result.ok });
    const endHalt = consultWatcherHalt(d.watcherTap.getHalt);
    if (endHalt.halted) {
      // The call itself completed; the EXECUTION must still die. The result is
      // returned honestly — the abort kills the container before the script
      // can act on much of it.
      abortExecution(endHalt.rejectionReason);
    }
    return toCallResult(result);
  }
}

function toCallResult(result: {
  ok: boolean;
  value?: string;
  error?: string;
  code?: string;
}): ScriptToolCallResult {
  if (result.ok) return { ok: true, value: result.value ?? '' };
  return {
    ok: false,
    error: result.error ?? 'Tool call failed',
    ...(result.code !== undefined ? { code: result.code } : {}),
  };
}
