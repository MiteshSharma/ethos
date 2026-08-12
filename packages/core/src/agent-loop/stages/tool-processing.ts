import type {
  AgentEvent,
  AgentSafety,
  Attachment,
  DryRunToolPlan,
  HookRegistry,
  LLMProvider,
  McpPolicy,
  Message,
  MessageContent,
  PersonalityConfig,
  PersonalityObservabilityConfig,
  ScriptToolsApi,
  SessionStore,
  SteerSink,
  Storage,
  ToolContext,
  ToolFilterOpts,
  ToolRegistry,
  ToolResult,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import type { ContextStore } from '../../context-store';
import { redactArgs } from '../../dry-run';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { SimpleCompletionImpl } from '../../simple-completion';
import { extractFilePath } from '../extract-file-path';
import { capIngestedResult } from '../ingestion-cap';
import { checkMcpEnabled, checkMcpRejectArgs } from '../mcp-policy';
import { handleUntrustedResult } from '../result-defense';
import { buildScopedStorage } from '../scoped-storage';
import type { WatcherTap } from '../turn-context';
import { consultWatcherHalt, enforceBeforeToolCall } from './per-call-enforcement';
import type { ScriptToolBridge } from './script-tool-bridge';
import type { CompletedToolCall, UsageSink } from './stream-step';
import { emitToolRejection, validateRepairedArgs } from './tool-rejection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessToolsResult =
  | { kind: 'continue'; successCount: number; hookDenials: number }
  | { kind: 'return-direct'; text: string; turnCount: number };

export interface ToolProcessingDeps {
  tools: ToolRegistry;
  hooks: HookRegistry;
  session: SessionStore;
  safety: AgentSafety;
  observability?: AgentLoopObservability;
  mcpPolicy?: McpPolicy;
  onToolMetric?: (opts: {
    pluginId: string;
    toolName: string;
    ok: boolean;
    durationMs: number;
    sessionId: string;
    turnId: string;
  }) => void;
  sessionCosts: Map<string, number>;
  storage?: Storage;
  dataDir?: string;
  platform: string;
  resultBudgetChars: number;
  teamId?: string;
  contextStore: ContextStore;
  sessionReadMtimes: Map<string, Map<string, { mtimeMs: number; readAtTurn: number }>>;
  llm: LLMProvider;
}

export interface ToolProcessingContext {
  completedToolCalls: CompletedToolCall[];
  sessionId: string;
  sessionKey: string;
  personality: PersonalityConfig;
  /** The turn's working directory — see `TurnSetup.workingDir`. Per-turn, not
   *  per-loop, because it comes from the turn's personality. */
  workingDir: string;
  /** The turn's `fs_reach` allowlist, from the same derivation as
   *  `workingDir` — see `TurnSetup.fsReach`. */
  fsReach: { read: string[]; write: string[] };
  traceId: string | undefined;
  obsConfig: PersonalityObservabilityConfig | undefined;
  effectiveModel: string;
  allowedTools: string[] | undefined;
  allowedPlugins: string[];
  filterOpts: ToolFilterOpts;
  llmMessages: Message[];
  abortSignal: AbortSignal;
  turnCount: number;
  baseMessageCount: number;
  memScopeId: string;
  userScopeId: string | undefined;
  watcherTap: WatcherTap;
  usageSink: UsageSink;
  /** tools-as-code-api Lane B — per-turn bridge for in-script tool calls. */
  scriptToolBridge?: ScriptToolBridge;

  // Downgrade state — mutable refs
  dgEnabled: boolean;
  dgRemaining: { value: number };
  dgTools: Set<string>;
  dgTurns: number;

  // Dry-run state — mutable refs
  dryRun: boolean;
  dryRunState: { callCount: number; cap: number; capped: number; plan: DryRunToolPlan[] };

  // Tier escalation ref
  tierEscalationRef: { value?: string };

  // Steer
  steerSink?: SteerSink;

  /** Set when this turn's text is a transcript of speech — threaded onto every
   *  `before_tool_call` payload so the approval surface can tell a spoken
   *  request from a typed one. Absent on typed turns. */
  voiceOrigin?: VoiceTurnOrigin;

  // Run options
  opts: {
    agentId?: string;
    rootSessionKey?: string;
    origin?: string;
    attachments?: Attachment[];
    dryRun?: boolean;
    userId?: string;
    a2aDelegation?: { traceId: string; depth: number; reserveOutbound: () => boolean };
  };
}

// ---------------------------------------------------------------------------
// processTools — one iteration's tool handling
// ---------------------------------------------------------------------------

export async function* processTools(
  deps: ToolProcessingDeps,
  ctx: ToolProcessingContext,
): AsyncGenerator<AgentEvent, ProcessToolsResult> {
  // Step 9: Pre-flight hooks → execute non-rejected tools → collect all results

  // Phase 30.2 — tools call ctx.emit() during execution. We drain events in
  // real-time via an async queue that runs concurrently with executeParallel.
  // The resolver is signalled on each push and on completion. Lane E widened
  // the queue from progress-only to AgentEvent so the ScriptToolBridge can
  // emit inner-call tool_start/tool_end (audience: 'internal') mid-execution
  // through the same drain.
  const progressQueue: AgentEvent[] = [];
  let progressQueueResolve: (() => void) | null = null;
  const pushLiveEvent = (event: AgentEvent): void => {
    progressQueue.push(event);
    progressQueueResolve?.();
    progressQueueResolve = null;
  };

  const scopedStorage = buildScopedStorage(deps.storage, deps.safety, ctx.fsReach);

  // FW-28 — retrieve or create the per-session mtime registry for this turn.
  let sessionMtimes = deps.sessionReadMtimes.get(ctx.sessionKey);
  if (!sessionMtimes) {
    sessionMtimes = new Map();
    deps.sessionReadMtimes.set(ctx.sessionKey, sessionMtimes);
  }

  // v2: clear per-run context store so plugins start fresh each run
  deps.contextStore.clear();

  const toolCtxBase = {
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: deps.platform,
    workingDir: ctx.workingDir,
    agentId: ctx.opts.agentId,
    rootSessionKey: ctx.opts.rootSessionKey ?? ctx.sessionKey,
    origin: ctx.opts.origin,
    ...(ctx.opts.a2aDelegation ? { a2aDelegation: ctx.opts.a2aDelegation } : {}),
    personalityId: ctx.personality.id,
    memoryScopeId: ctx.memScopeId,
    ...(ctx.userScopeId ? { userScopeId: ctx.userScopeId } : {}),
    ...(deps.teamId !== undefined && { teamId: deps.teamId }),
    ...(ctx.opts.dryRun ? { dryRun: true as const } : {}),
    currentTurn: ctx.turnCount,
    messageCount: ctx.baseMessageCount + ctx.turnCount,
    abortSignal: ctx.abortSignal,
    emit: (event: {
      type: 'progress';
      toolName: string;
      message: string;
      percent?: number;
      audience?: 'internal' | 'user' | 'dashboard';
    }) => {
      pushLiveEvent({
        type: 'tool_progress',
        toolName: event.toolName,
        message: event.message,
        ...(event.percent !== undefined && { percent: event.percent }),
        audience: event.audience ?? 'internal',
      });
    },
    resultBudgetChars: deps.resultBudgetChars,
    readMtimes: sessionMtimes,
    ...(scopedStorage ? { storage: scopedStorage } : {}),
    ...(ctx.personality.safety?.network ? { networkPolicy: ctx.personality.safety.network } : {}),
    ...deps.contextStore.asContextMethods(),
    llm: new SimpleCompletionImpl(deps.llm, ctx.effectiveModel, ({ input, output }) => {
      ctx.usageSink.llmInputTokens += input;
      ctx.usageSink.llmOutputTokens += output;
    }),
  };

  // tools-as-code-api Lane B — attach the per-turn bridge to this batch's
  // ToolContext. `bind` reads the context lazily so the bridge sees the final
  // object (including this very `scriptTools` field). Lane E: the bridge's
  // inner-call events ride the same live queue as tool progress.
  const scriptTools: ScriptToolsApi | undefined = ctx.scriptToolBridge?.bind(
    () => toolCtx,
    pushLiveEvent,
  );
  const toolCtx: ToolContext = scriptTools ? { ...toolCtxBase, scriptTools } : toolCtxBase;

  // Run before_tool_call hooks; build exec list with effective args
  // Rejected tools get tool_end ok:false + an error tool_result sent back to LLM
  type Prepped = { toolCallId: string; name: string; args: unknown; rejected?: string };
  const prepped: Prepped[] = [];
  // `before_tool_call` rejections only — see `updateDenialStreak` in budgets.ts.
  let hookDenials = 0;
  const spanIds = new Map<string, string>();

  const observe = ctx.watcherTap.observe;
  const getHalt = ctx.watcherTap.getHalt;

  for (const tc of ctx.completedToolCalls) {
    // §4 — the streamed arguments were unparseable and unrepairable. Never run
    // the tool with empty args; reject via the same Prepped.rejected path used
    // by hook/watcher rejections so the model gets a visible is_error result.
    if (tc.parseError !== undefined) {
      yield* emitToolRejection(observe, tc.toolCallId, tc.toolName, tc.parseError);
      prepped.push({
        toolCallId: tc.toolCallId,
        name: tc.toolName,
        args: tc.args ?? {},
        rejected: tc.parseError,
      });
      continue;
    }

    // §4 (remainder) + Lane 4a delta — the streamed arguments were REPAIRED,
    // so validate them against the tool's schema: stage-2 type coercion, then
    // the required-fields presence/type check w/ per-field feedback. Clean parses skip.
    if (tc.repair?.outcome === 'repaired') {
      const tool = deps.tools.get(tc.toolName);
      if (tool) {
        const validated = validateRepairedArgs(tool.schema, tc.args);
        tc.args = validated.args;
        if (validated.reason !== undefined) {
          yield* emitToolRejection(observe, tc.toolCallId, tc.toolName, validated.reason);
          prepped.push({
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            args: tc.args ?? {},
            rejected: validated.reason,
          });
          continue;
        }
      }
    }

    // Ch.3d — refuse downgraded tools while the post-untrusted-read
    // counter is positive. The user's next message clears the counter
    // (run() is invoked fresh; dgRemaining resets to 0).
    if (ctx.dgEnabled && ctx.dgRemaining.value > 0 && ctx.dgTools.has(tc.toolName)) {
      deps.observability?.recordSafetyBlock({
        traceId: ctx.traceId,
        code: 'tool_downgraded_post_untrusted_read',
        cause: tc.toolName,
      });
      yield* emitToolRejection(
        observe,
        tc.toolCallId,
        tc.toolName,
        deps.safety.injection.downgradeRejectionMessage,
      );
      prepped.push({
        toolCallId: tc.toolCallId,
        name: tc.toolName,
        args: tc.args,
        rejected: deps.safety.injection.downgradeRejectionMessage,
      });
      continue;
    }

    const beforeDecision = await enforceBeforeToolCall(
      { hooks: deps.hooks, observability: deps.observability },
      {
        sessionId: ctx.sessionId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        allowedPlugins: ctx.allowedPlugins,
        traceId: ctx.traceId,
        ...(ctx.voiceOrigin ? { voiceOrigin: ctx.voiceOrigin } : {}),
      },
    );

    if (!beforeDecision.allowed) {
      hookDenials++;
      yield* emitToolRejection(observe, tc.toolCallId, tc.toolName, beforeDecision.reason);
      prepped.push({
        toolCallId: tc.toolCallId,
        name: tc.toolName,
        args: tc.args,
        rejected: beforeDecision.reason,
      });
      continue;
    }

    const effectiveArgs = beforeDecision.effectiveArgs;

    // MCP enabled policy — short-circuit if the server is disabled for this personality.
    const enabledError = checkMcpEnabled(deps.mcpPolicy, tc.toolName);
    if (enabledError) {
      deps.observability?.recordSafetyBlock({
        traceId: ctx.traceId,
        code: 'tool_blocked',
        cause: enabledError,
      });
      yield* emitToolRejection(observe, tc.toolCallId, tc.toolName, enabledError);
      prepped.push({
        toolCallId: tc.toolCallId,
        name: tc.toolName,
        args: effectiveArgs,
        rejected: enabledError,
      });
      continue;
    }

    // MCP reject_args policy — checked after hooks so modified args are evaluated.
    const rejectError = checkMcpRejectArgs(deps.mcpPolicy, tc.toolName, effectiveArgs);
    if (rejectError) {
      deps.observability?.recordSafetyBlock({
        traceId: ctx.traceId,
        code: 'tool_blocked',
        cause: rejectError,
      });
      yield* emitToolRejection(observe, tc.toolCallId, tc.toolName, rejectError);
      prepped.push({
        toolCallId: tc.toolCallId,
        name: tc.toolName,
        args: effectiveArgs,
        rejected: rejectError,
      });
      continue;
    }

    const spanId = deps.observability?.startSpan({
      traceId: ctx.traceId ?? '',
      kind: 'tool_call',
      name: tc.toolName,
      attrs: { args: JSON.stringify(effectiveArgs).slice(0, 4096) },
      obsConfig: ctx.obsConfig,
    });
    spanIds.set(tc.toolCallId, spanId ?? '');
    // v2: requiresApproval is ANNOUNCEMENT ONLY, NOT A GATE — this emits the
    // event then runs the tool regardless, and nothing consumes it. The real
    // gate is the `before_tool_call` approval hook, whose danger predicate flags
    // tools BY NAME (`APPROVAL_SURFACE_ALWAYS_ASK`, packages/wiring). v2.2 scope.
    const reqApprovalTool = deps.tools.get(tc.toolName);
    if (reqApprovalTool?.requiresApproval) {
      yield {
        type: 'tool_approval_required',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: effectiveArgs,
      };
    }

    observe({ type: 'tool_start', toolName: tc.toolName, args: effectiveArgs });
    yield {
      type: 'tool_start',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: effectiveArgs,
    };
    prepped.push({ toolCallId: tc.toolCallId, name: tc.toolName, args: effectiveArgs });
  }

  // Ch.6a — if observe() of any tool_start in this batch produced
  // a non-allow decision, mark every still-unrejected tool as
  // rejected and skip executeParallel. The decision was emitted
  // BEFORE the tool ran; we must not let it run anyway. This is
  // the bug Codex called out: the iteration-top check would only
  // fire AFTER the batch executed.
  const haltDuringBatch = consultWatcherHalt(getHalt);
  if (haltDuringBatch.halted) {
    for (const p of prepped) {
      if (p.rejected === undefined) {
        p.rejected = haltDuringBatch.rejectionReason;
      }
    }
  }

  // Execute only non-rejected tools; results keyed by toolCallId
  const execInputs = prepped
    .filter((p) => p.rejected === undefined)
    .map((p) => ({ toolCallId: p.toolCallId, name: p.name, args: p.args }));

  const batchStartedAt = Date.now();
  let toolsDone = false;
  const toolsPromise =
    execInputs.length > 0
      ? deps.tools.executeParallel(
          execInputs,
          toolCtx,
          ctx.allowedTools,
          ctx.filterOpts,
          ctx.opts.attachments,
        )
      : Promise.resolve([]);
  // Signal the drain loop when tools complete (success or error).
  toolsPromise.then(
    () => {
      toolsDone = true;
      progressQueueResolve?.();
      progressQueueResolve = null;
    },
    () => {
      toolsDone = true;
      progressQueueResolve?.();
      progressQueueResolve = null;
    },
  );
  // Drain live events (tool progress + inner-call start/end) while tools execute.
  while (!toolsDone || progressQueue.length > 0) {
    while (progressQueue.length > 0) {
      const ev = progressQueue.shift();
      if (ev) {
        yield ev;
      }
    }
    if (!toolsDone) {
      await new Promise<void>((r) => {
        progressQueueResolve = r;
      });
    }
  }
  const execResults = await toolsPromise;
  const execResultMap = new Map(execResults.map((r) => [r.toolCallId, r]));

  // v2: returnDirect — skip LLM synthesis if a returnDirect tool succeeded
  const directResult = execResults.find((r) => {
    const t = deps.tools.get(r.name);
    return r.result.ok && t?.returnDirect;
  });
  if (directResult?.result.ok) {
    // Persist tool results for history fidelity
    for (const p of prepped) {
      const execResult = execResultMap.get(p.toolCallId);
      const result: ToolResult = p.rejected
        ? { ok: false as const, error: p.rejected, code: 'execution_failed' as const }
        : (execResult?.result ?? {
            ok: false as const,
            error: 'Tool result missing',
            code: 'execution_failed' as const,
          });
      await deps.session.appendMessage({
        sessionId: ctx.sessionId,
        role: 'tool_result',
        // Lane 1(c) — same ingestion cap as the main persist path below.
        content: capIngestedResult(result.ok ? result.value : result.error, deps.resultBudgetChars),
        toolCallId: p.toolCallId,
        toolName: p.name,
        traceId: ctx.traceId,
      });
    }
    // Emit tool_end for all completed tools
    for (const r of execResults) {
      yield {
        type: 'tool_end',
        toolCallId: r.toolCallId,
        toolName: r.name,
        ok: r.result.ok,
        durationMs: r.durationMs ?? Date.now() - batchStartedAt,
        result: r.result.ok ? r.result.value : r.result.error,
        ...(r.result.ok && r.result.structured !== undefined
          ? { structured: r.result.structured }
          : {}),
        ...(r.result.ok ? {} : { error: r.result.error }),
      };
    }
    if (ctx.traceId) deps.observability?.endTrace(ctx.traceId, 'ok');
    deps.observability?.flush();
    yield { type: 'done', text: directResult.result.value, turnCount: ctx.turnCount };
    return { kind: 'return-direct', text: directResult.result.value, turnCount: ctx.turnCount };
  }

  // Dry-run plan collection — record every executed tool call and track the cap.
  if (ctx.dryRun) {
    for (const input of execInputs) {
      ctx.dryRunState.plan.push({
        toolCallId: input.toolCallId,
        toolName: input.name,
        args: redactArgs(input.args, deps.safety.redaction.redactString),
      });
      ctx.dryRunState.callCount++;
      if (ctx.dryRunState.callCount >= ctx.dryRunState.cap) {
        // Count remaining tool calls in this batch that will be capped
        const remaining = execInputs.length - execInputs.indexOf(input) - 1;
        ctx.dryRunState.capped += remaining;
        break;
      }
    }
  }

  // Detect think_deeper tool success → set run-local tier escalation for next LLM call.
  // Only fires when: (1) the personality declares a tier object, (2) its provider matches
  // the active LLM, and (3) the tool named 'think_deeper' returned ok.
  if (typeof ctx.personality.model === 'object' && ctx.personality.provider === deps.llm.name) {
    for (const r of execResults) {
      if (r.name === 'think_deeper' && r.result.ok) {
        ctx.tierEscalationRef.value = 'deep';
        break;
      }
    }
  }

  // Persist results + emit tool_end + build tool_result content blocks (original order)
  const toolResultContent: MessageContent[] = [];
  // Ch.3d — set when any tool we ran this iteration was outputIsUntrusted.
  // Decremented at the *top* of the next iteration, so a downgraded tool in
  // the same iteration also catches against the counter we set below.
  let untrustedReadThisIteration = false;

  let localSuccessfulToolCalls = 0;

  for (const p of prepped) {
    let result: ToolResult;
    // Ch.3a — `result` carries the original raw value for tool_end events
    // and after_tool_call hooks (the user-visible chip and audit trail
    // see what the tool actually returned). `llmContent` is the LLM-
    // facing string — possibly wrapped in `<untrusted>…</untrusted>` —
    // and is what gets persisted to history so toLLMMessages() replays
    // the exact bytes the model saw on the prior turn.
    let llmContent: string;
    // Ch.3a — set when this result went through the injection pipeline, so the
    // delimiter fence below covers untrusted errors as well as untrusted values.
    let passedInjectionPipeline = false;

    if (p.rejected !== undefined) {
      result = { ok: false, error: p.rejected, code: 'execution_failed' };
      // Lane 1(c) — hook-authored rejection reasons ride the same ingestion
      // cap as executed results (a plugin hook can return arbitrary text).
      llmContent = capIngestedResult(p.rejected, deps.resultBudgetChars);
      // tool_end already emitted above; no after_tool_call hook for blocked tools
    } else {
      const execResult = execResultMap.get(p.toolCallId);
      const durationMs = execResult?.durationMs ?? Date.now() - batchStartedAt;
      // Ch.3a provenance — the ONLY known-internal result on this branch is the
      // fallback we construct right here (the registry lost the call). It is
      // identified by its construction site, not by inspecting its text.
      const frameworkAuthored = execResult === undefined;
      result = execResult?.result ?? {
        ok: false,
        error: 'Tool result missing',
        code: 'execution_failed',
      };
      const sid = spanIds.get(p.toolCallId);
      if (sid) {
        deps.observability?.endSpan(sid, result.ok ? 'ok' : 'error', {
          result_size_bytes: result.ok ? result.value.length : undefined,
          durationMs,
        });
      }
      observe({ type: 'tool_end', toolName: p.name, ok: result.ok });
      if (result.ok) localSuccessfulToolCalls++;
      yield {
        type: 'tool_end',
        toolCallId: p.toolCallId,
        toolName: p.name,
        ok: result.ok,
        durationMs,
        result: result.ok ? result.value : result.error,
        ...(result.ok && result.structured !== undefined ? { structured: result.structured } : {}),
        ...(result.ok ? {} : { error: result.error }),
      };
      // Aggregate tool-incurred costs (e.g. image generation, vision LLM calls)
      // into the session budget so /usage and budgetCapUsd see them.
      if (result.ok && result.cost_usd) {
        deps.sessionCosts.set(
          ctx.sessionKey,
          (deps.sessionCosts.get(ctx.sessionKey) ?? 0) + result.cost_usd,
        );
        yield {
          type: 'usage',
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: result.cost_usd,
        };
      }
      await deps.hooks.fireVoid(
        'after_tool_call',
        {
          sessionId: ctx.sessionId,
          toolName: p.name,
          result,
          durationMs,
        },
        ctx.allowedPlugins,
      );

      // v2.2 — push auto-metric for plugin tool invocations
      if (deps.onToolMetric) {
        const pluginId = deps.tools.getPluginId?.(p.name);
        if (pluginId) {
          deps.onToolMetric({
            pluginId,
            toolName: p.name,
            ok: result.ok,
            durationMs,
            sessionId: ctx.sessionId,
            turnId: String(ctx.turnCount),
          });
        }
      }

      // E5 — surface the touched filesystem path so subscribers (e.g. the
      // file-context injector's progressive discovery) can react to where
      // the agent is navigating without scanning every tool's args
      // themselves.
      const touchedPath = extractFilePath(p.args);
      if (touchedPath !== undefined) {
        await deps.hooks.fireVoid(
          'tool_end_with_path',
          {
            sessionId: ctx.sessionId,
            personalityId: ctx.personality.id,
            toolName: p.name,
            filePath: touchedPath,
            workingDir: ctx.workingDir,
          },
          ctx.allowedPlugins,
        );
      }

      llmContent = result.ok ? result.value : result.error;

      if (result.ok && result.value) {
        const detections = deps.safety.redaction.detectSecrets(result.value);
        if (detections.length > 0) {
          deps.observability?.recordSafetyBlock?.({
            traceId: ctx.traceId,
            code: 'secret_in_tool_result',
            cause: detections.map((d) => d.label).join(', '),
          });
          // S9 — secret-result blocking is ON by default. Unset (undefined)
          // blocks; an explicit `false` opts out.
          if (ctx.personality.safety?.injectionDefense?.blockSecretResults ?? true) {
            const redactStr = deps.safety.redaction.redactString;
            result = { ...result, value: redactStr(result.value) };
            llmContent = result.value;
          }
        }
      }

      // Lane 1(c) — ingestion cap, applied BEFORE the untrusted wrap
      // (post-review FIX 7: capping the wrapped content could sever the
      // closing </untrusted> tag, leaving the fence open for everything
      // after it) and before the delimiter wrap so the END marker is never
      // cut off, and before persistence (see agent-loop/ingestion-cap.ts).
      llmContent = capIngestedResult(llmContent, deps.resultBudgetChars);

      // Ch.3a + 3c — provenance wrap + Tier-1 pattern check + optional Tier-2
      // LLM classifier. §V S6: unconditional — no personality knob skips it,
      // and neither does the ok/error discriminant. This was gated on
      // `result.ok` on the claim that errors are framework-authored; false for
      // exactly the tools the defense exists for — MCP tools declare
      // `outputIsUntrusted` and a server answering `isError: true` has its own
      // text lifted verbatim into `error` (extensions/tools-mcp). One boolean
      // bypassed both the wrap and the downgrade.
      //
      // Framework-authored is decided by construction site, never by reading
      // the string: `p.rejected` (handled above, never reaches here) and the
      // `Tool result missing` fallback flagged as `frameworkAuthored` above.
      // Everything else came from `executeParallel` and is indistinguishable
      // here from tool-authored text — `ToolResult` has no origin field and
      // `code` is tool-controlled — so it takes the fail-safe side.
      //
      // Wraps the already-capped content, so the wrapper (a small constant) is
      // the only growth past the budget and the fence always terminates.
      if (!frameworkAuthored) {
        const tool = deps.tools.get(p.name);
        if (tool?.outputIsUntrusted) {
          const verdict = await handleUntrustedResult(
            p.name,
            p.args,
            llmContent,
            ctx.personality,
            ctx.traceId,
            deps.safety,
            deps.observability,
          );
          llmContent = verdict.wrappedContent;
          passedInjectionPipeline = true;
          if (verdict.containsInstructions) {
            deps.observability?.recordSafetyBlock({
              traceId: ctx.traceId,
              code: 'injection_detected',
              cause: verdict.reason ?? 'pattern-hit',
            });
            yield {
              type: 'tool_progress',
              toolName: p.name,
              message: `⚠ external content may contain instructions${verdict.reason ? ` (${verdict.reason})` : ''}`,
              audience: 'user',
            };
          }
          // Ch.3d — arms on the error path too; wrapping without arming still
          // lets the next call reach a dangerous tool.
          untrustedReadThisIteration = true;
        }
      }
    }

    const delimiterEnabled = ctx.personality.safety?.injectionDefense?.toolResultDelimiters ?? true;
    let finalContent: string;
    // Fence successes plus any error that carried untrusted content — the
    // escaping below is what stops attacker text forging a framework
    // delimiter, and that text is now reachable on the error path.
    if (delimiterEnabled && (result.ok || passedInjectionPipeline)) {
      const escaped = llmContent
        .replace(/===TOOL_RESULT_START/g, '=​==TOOL_RESULT_START')
        .replace(/===TOOL_RESULT_END/g, '=​==TOOL_RESULT_END');
      finalContent = `===TOOL_RESULT_START:${p.name}===\n${escaped}\n===TOOL_RESULT_END===`;
    } else {
      finalContent = llmContent;
    }

    // Persist what the LLM sees, delimiters included — stored bytes are the replay bytes (Lane 2b, #4555).
    await deps.session.appendMessage({
      sessionId: ctx.sessionId,
      role: 'tool_result',
      content: finalContent,
      toolCallId: p.toolCallId,
      toolName: p.name,
      traceId: ctx.traceId,
    });

    toolResultContent.push({
      type: 'tool_result',
      tool_use_id: p.toolCallId,
      content: finalContent,
      is_error: !result.ok,
    });
  }

  // Ch.3d — decrement the prior iteration's counter, then arm a fresh
  // window if we just read untrusted content. The decrement-then-set
  // order means an untrusted read in iteration N protects iterations
  // N+1 .. N+turns.
  if (ctx.dgRemaining.value > 0) ctx.dgRemaining.value--;
  if (ctx.dgEnabled && untrustedReadThisIteration) {
    ctx.dgRemaining.value = ctx.dgTurns;
  }

  // FW-9 — drain SteerSink at the iteration seam. Each entry becomes a
  // `[USER STEER]: <text>` text block appended to the tool_results user
  // message. Also persisted as a `user_steer` row for transcript fidelity
  // so a future getMessages() call replays the steer cleanly.
  if (ctx.steerSink) {
    const steers = ctx.steerSink.drain();
    for (const steerText of steers) {
      toolResultContent.push({ type: 'text', text: `[USER STEER]: ${steerText}` });
      await deps.session.appendMessage({
        sessionId: ctx.sessionId,
        role: 'user_steer',
        content: steerText,
        traceId: ctx.traceId,
      });
    }
  }

  // Feed all tool results back to LLM as a single user message with content blocks
  ctx.llmMessages.push({ role: 'user', content: toolResultContent });

  return { kind: 'continue', successCount: localSuccessfulToolCalls, hookDenials };
}
