import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  HookRegistry,
  LLMProvider,
  Message,
  MessageContent,
  ModelTierName,
  PersonalityConfig,
  PersonalityObservabilityConfig,
  RequestDumpStore,
  SessionStore,
  ToolFilterOpts,
  ToolRegistry,
} from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { handleChunk } from '../chunk-handler';
import { isContextOverflowError } from '../overflow';
import type { WatcherTap } from '../turn-context';
import { resolveModelWithTier } from '../turn-context';
import type { TurnUsageAccumulator } from './turn-finalizer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageSink {
  llmInputTokens: number;
  llmOutputTokens: number;
}

export interface CompletedToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  // Set when the streamed arguments were unparseable and unrepairable. The
  // call still reaches tool-processing (so the tool_use gets a matching
  // tool_result) but is rejected there instead of executing with empty args.
  parseError?: string;
  // Set only when strict parse failed and a mechanical repair pass ran.
  // `outcome: 'repaired'` means `args` is the repaired object — tool-processing
  // validates it against the tool's `required` fields (§4) before executing,
  // since a repair signals the model produced malformed output.
  repair?: { outcome: 'repaired' | 'failed' };
}

export type StreamStepResult =
  | { outcome: 'text-end'; chunkText: string; fullTextDelta: string; usageSink: UsageSink }
  | {
      outcome: 'tool-calls';
      completedToolCalls: CompletedToolCall[];
      chunkText: string;
      fullTextDelta: string;
      usageSink: UsageSink;
    }
  // Phase 3 — the provider rejected the request for exceeding the context
  // window. No `error` event is emitted here so the orchestrator can
  // compact-and-retry; if the retry is disabled or already spent, the caller
  // surfaces a `context_overflow` error itself.
  | { outcome: 'overflow'; error: string }
  | { outcome: 'fatal' };

// ---------------------------------------------------------------------------
// Dependencies & context
// ---------------------------------------------------------------------------

export interface StreamStepDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  hooks: HookRegistry;
  session: SessionStore;
  observability?: AgentLoopObservability;
  requestDumpStore?: RequestDumpStore;
  sessionCosts: Map<string, number>;
  /** A1 — per-turn rollup accumulator, flushed by the turn finalizer. */
  turnUsage: TurnUsageAccumulator;
  streamingTimeoutMs: number;
  modelRouting: Record<string, string>;
}

export interface StreamStepContext {
  sessionId: string;
  sessionKey: string;
  personalityId: string;
  personality: PersonalityConfig;
  traceId: string | undefined;
  obsConfig: PersonalityObservabilityConfig | undefined;
  activeTier: ModelTierName;
  effectiveModel: string;
  modelOverride: string | undefined;
  allowedPlugins: string[];
  allowedTools: string[] | undefined;
  filterOpts: ToolFilterOpts;
  systemPrompt: string | undefined;
  llmMessages: Message[];
  cacheBreakpoints: number[] | undefined;
  abortSignal: AbortSignal;
  turnCount: number;
  watcherTap: WatcherTap;
  opts: {
    temperature?: number;
    topP?: number;
    maxCompletionTokens?: number;
    seed?: number;
    /** Provider-namespaced escape hatch (§7 carries topK/minP here). */
    providerOptions?: Record<string, Record<string, unknown>>;
  };
}

// ---------------------------------------------------------------------------
// Terminal-failure persistence
// ---------------------------------------------------------------------------

/**
 * Persist the partial assistant text produced before a TERMINAL stream failure
 * (stalled watchdog / provider error). Nothing retries those paths and the
 * orchestrator returns immediately on `outcome: 'fatal'`, so without this the
 * text lives only in the client's streaming buffer and vanishes as soon as the
 * next turn reloads history from the store.
 *
 * Text only — any tool calls still in flight never ran and never will, so their
 * `tool_use` blocks would be orphans in the replayed history. Dropping them is
 * the cheaper half of the Anthropic tool_use/tool_result contract.
 *
 * Deliberately NOT called on the recoverable `overflow` path: that one compacts
 * and retries, and needs the clean history it has always had.
 *
 * Empty (or whitespace-only) text is not persisted — an empty assistant turn is
 * noise, not context.
 */
async function persistInterruptedAssistant(
  session: SessionStore,
  sessionId: string,
  text: string,
  reason: string,
  traceId: string | undefined,
): Promise<void> {
  if (!text.trim()) return;
  // Provider error messages can be multi-KB (HTML error pages, JSON dumps) and
  // this marker replays into the next turn's context — keep it a label, not a
  // payload. The full message still reaches the client on the `error` event.
  const label = reason.length > 200 ? `${reason.slice(0, 200)}…` : reason;
  await session.appendMessage({
    sessionId,
    role: 'assistant',
    content: `${text}\n\n[interrupted — ${label}]`,
    traceId,
  });
}

// ---------------------------------------------------------------------------
// streamStep — one LLM streaming call
// ---------------------------------------------------------------------------

export async function* streamStep(
  deps: StreamStepDeps,
  ctx: StreamStepContext,
  pendingTierEscalation: { value?: string },
): AsyncGenerator<AgentEvent, StreamStepResult> {
  // Compute tool definitions once for hooks, LLM call, and dump store.
  const toolDefs = deps.tools.toDefinitions(ctx.allowedTools, ctx.filterOpts);
  const requestId = randomUUID();
  const includeContent = ctx.obsConfig?.storeLlmPayloads === 'full';

  // Fire before_llm_call — content only included when personality opts in
  await deps.hooks.fireVoid(
    'before_llm_call',
    {
      sessionId: ctx.sessionId,
      model: deps.llm.model,
      turnNumber: ctx.turnCount,
      requestId,
      ...(includeContent
        ? { system: ctx.systemPrompt, tools: toolDefs, messages: ctx.llmMessages }
        : {}),
    },
    ctx.allowedPlugins,
  );

  // Stream LLM response
  const pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    partialJson: string;
    args?: unknown;
    parseError?: string;
    repair?: { outcome: 'repaired' | 'failed' };
  }> = [];
  let chunkText = '';
  let fullTextDelta = '';

  // Streaming watchdog: cancel the stream if no chunk arrives within the
  // per-personality window. Reset every chunk so slow-but-progressing
  // reasoning is unaffected. See IMPROVEMENT.md P1-2 / OpenClaw #68596.
  const watchdogMs = ctx.personality.streamingTimeoutMs ?? deps.streamingTimeoutMs;
  const watchdogController = new AbortController();
  const combinedSignal = AbortSignal.any([ctx.abortSignal, watchdogController.signal]);
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => watchdogController.abort(), watchdogMs);
  };
  const disarmWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };

  // Consume one-shot tier escalation from think_deeper tool result (run-local).
  let iterModelOverride = ctx.modelOverride;
  if (pendingTierEscalation.value && typeof ctx.personality.model === 'object') {
    const tier = pendingTierEscalation.value as ModelTierName;
    pendingTierEscalation.value = undefined;
    const { model: tierModel } = resolveModelWithTier(
      ctx.personality,
      tier,
      deps.modelRouting,
      deps.llm.name,
      deps.llm.model,
    );
    iterModelOverride = tierModel !== deps.llm.model ? tierModel : undefined;
    deps.observability?.recordTierEscalation({
      traceId: ctx.traceId ?? '',
      from: ctx.activeTier,
      to: tier,
      reason: 'tool_escalation',
      personalityId: ctx.personality.id,
    });
  }

  const llmSpanId = deps.observability?.startSpan({
    traceId: ctx.traceId ?? '',
    kind: 'llm_call',
    name: iterModelOverride ?? deps.llm.model ?? 'unknown',
  });
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let llmCacheReadTokens = 0;
  let llmCacheCreationTokens = 0;
  let llmEstimatedCostUsd = 0;
  let llmRequestTokens: { system: number; tools: number; messages: number } | undefined;
  let llmFinishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | undefined;
  // B2 — the provider's server-assigned id for this call, when it reports one.
  let providerRequestId: string | undefined;
  const llmStartTs = Date.now();

  try {
    armWatchdog();
    const stream = deps.llm.complete(ctx.llmMessages, toolDefs, {
      system: ctx.systemPrompt,
      cacheSystemPrompt: true,
      abortSignal: combinedSignal,
      // B2 — the client-minted id above goes outward where the provider
      // supports it (openai-compat: `X-Client-Request-Id`), so a provider-side
      // log line can be matched back to this call. Providers without a
      // client-id convention ignore it.
      requestId,
      ...(iterModelOverride ? { modelOverride: iterModelOverride } : {}),
      ...(ctx.cacheBreakpoints ? { cacheBreakpoints: ctx.cacheBreakpoints } : {}),
      ...(ctx.opts.temperature !== undefined ? { temperature: ctx.opts.temperature } : {}),
      ...(ctx.opts.topP !== undefined ? { topP: ctx.opts.topP } : {}),
      ...(ctx.opts.maxCompletionTokens !== undefined
        ? { maxTokens: ctx.opts.maxCompletionTokens }
        : {}),
      ...(ctx.opts.seed !== undefined ? { seed: ctx.opts.seed } : {}),
      ...(ctx.opts.providerOptions ? { providerOptions: ctx.opts.providerOptions } : {}),
    });

    for await (const chunk of stream) {
      if (ctx.abortSignal.aborted) break;
      if (watchdogController.signal.aborted) break;
      armWatchdog();
      if (chunk.type === 'done') llmFinishReason = chunk.finishReason;
      if (chunk.type === 'usage') {
        if (chunk.providerRequestId) providerRequestId = chunk.providerRequestId;
        llmCacheReadTokens += chunk.usage.cacheReadTokens;
        llmCacheCreationTokens += chunk.usage.cacheCreationTokens;
        llmEstimatedCostUsd += chunk.usage.estimatedCostUsd;
        if (chunk.usage.requestTokens) llmRequestTokens = chunk.usage.requestTokens;
      }
      for (const event of handleChunk(chunk, pendingToolCalls, (t) => {
        chunkText += t;
        fullTextDelta += t;
      })) {
        if (event.type === 'usage') {
          deps.sessionCosts.set(
            ctx.sessionKey,
            (deps.sessionCosts.get(ctx.sessionKey) ?? 0) + event.estimatedCostUsd,
          );
          llmInputTokens += event.inputTokens;
          llmOutputTokens += event.outputTokens;
          ctx.watcherTap.observe({
            type: 'usage',
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          });
        }
        yield event;
      }
    }
    disarmWatchdog();
    // Phase 0 — persist the per-slice {system, tools, messages} breakdown and
    // cache stats onto the llm_call span so the context anatomy is attributable
    // to named sections. Best-effort: attrs merge into the span at close.
    deps.observability?.endSpan(llmSpanId ?? '', 'ok', {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      cacheReadTokens: llmCacheReadTokens,
      cacheCreationTokens: llmCacheCreationTokens,
      // A2 — the span used to carry tokens but no money, so every cost
      // aggregate over `llm_call` spans read 0. This is the provider's own
      // reported cost (already summed off the usage chunks above), not a
      // re-derivation: core must not depend on @ethosagent/pricing.
      estimatedCostUsd: llmEstimatedCostUsd,
      // B2 — the two request ids, kept apart on purpose. `clientRequestId` is
      // ours (minted above, sent outbound); `providerRequestId` is the
      // server's, and it is the one a provider support ticket asks for.
      clientRequestId: requestId,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
    });

    if (watchdogController.signal.aborted && !ctx.abortSignal.aborted) {
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      // Persist before yielding — a consumer that stops iterating on the error
      // event closes the generator, and nothing after the yield would run.
      await persistInterruptedAssistant(
        deps.session,
        ctx.sessionId,
        chunkText,
        `LLM stream stalled after ${watchdogMs}ms`,
        ctx.traceId,
      );
      yield {
        type: 'error',
        error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
        code: 'streaming_timeout',
      };
      return { outcome: 'fatal' };
    }
  } catch (err) {
    disarmWatchdog();
    // B2 — a failed call is exactly the one an operator quotes in a support
    // ticket, so the ids go on the error span too.
    deps.observability?.endSpan(llmSpanId ?? '', 'error', {
      clientRequestId: requestId,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    if (watchdogController.signal.aborted && !ctx.abortSignal.aborted) {
      deps.observability?.endTrace(ctx.traceId ?? '', 'error');
      deps.observability?.flush();
      await persistInterruptedAssistant(
        deps.session,
        ctx.sessionId,
        chunkText,
        `LLM stream stalled after ${watchdogMs}ms`,
        ctx.traceId,
      );
      yield {
        type: 'error',
        error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
        code: 'streaming_timeout',
      };
      return { outcome: 'fatal' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Phase 3 — a context-overflow rejection is recoverable: hand it back to the
    // orchestrator (no `error` event) so it can compact-and-retry. The assistant
    // message is deliberately NOT persisted on this path (unlike the terminal
    // failures above), so the retry starts from a clean history.
    if (isContextOverflowError(err)) {
      deps.observability?.recordCompaction({
        severity: 'warn',
        code: 'context_overflow_retry',
        cause: msg,
      });
      return { outcome: 'overflow', error: msg };
    }
    deps.observability?.endTrace(ctx.traceId ?? '', 'error');
    deps.observability?.flush();
    await persistInterruptedAssistant(deps.session, ctx.sessionId, chunkText, msg, ctx.traceId);
    yield { type: 'error', error: msg, code: 'llm_error' };
    return { outcome: 'fatal' };
  }

  const usageSink: UsageSink = { llmInputTokens, llmOutputTokens };

  // Record one observability event per tool-call repair attempt (§4). Only
  // fires when a strict parse failed and the repair pass ran — feeds the §9
  // per-model repair-rate metric.
  for (const tc of pendingToolCalls) {
    if (tc.repair) {
      deps.observability?.recordToolRepair?.({
        traceId: ctx.traceId,
        toolName: tc.toolName,
        outcome: tc.repair.outcome,
      });
    }
  }

  // Determine which tool calls completed parsing. Calls with a parse error are
  // kept — they still need a matching tool_result (rejected in tool-processing)
  // to satisfy the tool_use/tool_result contract; they never execute.
  const completedToolCalls = pendingToolCalls.filter(
    (tc): tc is typeof tc & { args: unknown } =>
      tc.args !== undefined || tc.parseError !== undefined,
  );

  // Persist assistant message — include tool_use references so history is LLM-replayable
  // Note: turnCount + 1 matches the original code where turnCount was already incremented
  await deps.session.appendMessage({
    sessionId: ctx.sessionId,
    role: 'assistant',
    content: chunkText,
    ...(completedToolCalls.length > 0 && {
      toolCalls: completedToolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        // Malformed args are recorded as `{}` in the tool_use history block;
        // the call is rejected (not executed) in tool-processing.
        input: tc.args ?? {},
      })),
    }),
    // Phase 0 — fold this turn's actual usage into the same message-persist
    // transaction (columns already exist, previously always NULL). The gate's
    // actuals-first signal (Phase 1c) reads back the most recent assistant
    // message's `inputTokens`.
    usage: {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      cacheReadTokens: llmCacheReadTokens,
      cacheCreationTokens: llmCacheCreationTokens,
      estimatedCostUsd: llmEstimatedCostUsd,
      ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
    },
    // A3 — the turn's observability trace id, so this row joins to the trace
    // and its `llm_call` span in `observability.db`.
    traceId: ctx.traceId,
  });

  // A1 — mirror the row just written into the turn's rollup accumulator. Kept
  // adjacent to the append so the session's cached usage columns can only ever
  // reflect message rows that actually landed (analytics decision 9).
  deps.turnUsage.inputTokens += llmInputTokens;
  deps.turnUsage.outputTokens += llmOutputTokens;
  deps.turnUsage.cacheReadTokens += llmCacheReadTokens;
  deps.turnUsage.cacheCreationTokens += llmCacheCreationTokens;
  deps.turnUsage.estimatedCostUsd += llmEstimatedCostUsd;

  // Fire after_llm_call — content gated by personality observability config
  const llmDurationMs = Date.now() - llmStartTs;
  await deps.hooks.fireVoid(
    'after_llm_call',
    {
      sessionId: ctx.sessionId,
      text: chunkText,
      usage: {
        inputTokens: llmInputTokens,
        outputTokens: llmOutputTokens,
        ...(llmCacheReadTokens ? { cacheReadTokens: llmCacheReadTokens } : {}),
        ...(llmCacheCreationTokens ? { cacheCreationTokens: llmCacheCreationTokens } : {}),
        ...(llmEstimatedCostUsd ? { estimatedCostUsd: llmEstimatedCostUsd } : {}),
        ...(llmRequestTokens ? { requestTokens: llmRequestTokens } : {}),
      },
      requestId,
      finishReason: llmFinishReason,
      durationMs: llmDurationMs,
      ...(includeContent
        ? { system: ctx.systemPrompt, tools: toolDefs, messages: ctx.llmMessages }
        : {}),
    },
    ctx.allowedPlugins,
  );

  // Append to request dump store if wired (awaited for reliability).
  // Content fields only included when personality observability opts in.
  // turnNumber uses turnCount + 1 to match the original post-increment behavior.
  if (deps.requestDumpStore) {
    await deps.requestDumpStore.append({
      // B2 — `requestId` is the client-minted outbound id; `providerRequestId`
      // is the server-assigned one. Same pair as the `llm_call` span attrs.
      requestId,
      ...(providerRequestId ? { providerRequestId } : {}),
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionId,
      personalityId: ctx.personality.id,
      turnNumber: ctx.turnCount + 1,
      model: iterModelOverride ?? deps.llm.model,
      durationMs: llmDurationMs,
      requestTokens: llmRequestTokens,
      responseTokens: llmOutputTokens || undefined,
      cacheReadTokens: llmCacheReadTokens || undefined,
      cacheCreationTokens: llmCacheCreationTokens || undefined,
      estimatedCostUsd: llmEstimatedCostUsd || undefined,
      finishReason: llmFinishReason,
      ...(includeContent
        ? {
            system: ctx.systemPrompt,
            tools: toolDefs,
            messages: ctx.llmMessages,
            responseText: chunkText,
          }
        : {}),
    });
  }

  // Push assistant message with proper content blocks for next iteration
  if (completedToolCalls.length > 0) {
    const assistantContent: MessageContent[] = [];
    if (chunkText) assistantContent.push({ type: 'text', text: chunkText });
    for (const tc of completedToolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args ?? {},
      });
    }
    ctx.llmMessages.push({ role: 'assistant', content: assistantContent });
    return { outcome: 'tool-calls', completedToolCalls, chunkText, fullTextDelta, usageSink };
  }

  ctx.llmMessages.push({ role: 'assistant', content: chunkText });
  return { outcome: 'text-end', chunkText, fullTextDelta, usageSink };
}
