import type {
  CompletionChunk,
  ContextInjector,
  HookRegistry,
  LLMProvider,
  MemoryProvider,
  Message,
  MessageContent,
  PersonalityRegistry,
  PromptContext,
  SessionStore,
  StoredMessage,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';

import { InMemorySessionStore } from './defaults/in-memory-session';
import { NoopMemoryProvider } from './defaults/noop-memory';
import { DefaultPersonalityRegistry } from './defaults/noop-personality';
import { DefaultHookRegistry } from './hook-registry';
import { DefaultToolRegistry } from './tool-registry';

// ---------------------------------------------------------------------------
// Agent events emitted by run()
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress'; toolName: string; message: string; percent?: number }
  | { type: 'tool_end'; toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error'; error: string; code: string }
  | { type: 'done'; text: string; turnCount: number }
  // Emitted once after context injectors run; carries any metadata they wrote to PromptContext.meta.
  | { type: 'context_meta'; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  llm: LLMProvider;
  tools?: ToolRegistry;
  personalities?: PersonalityRegistry;
  memory?: MemoryProvider;
  session?: SessionStore;
  hooks?: HookRegistry;
  injectors?: ContextInjector[];
  // Maps personality ID → model ID. Resolution: modelRouting[id] → personality.model → llm.model
  modelRouting?: Record<string, string>;
  options?: {
    maxIterations?: number;
    historyLimit?: number;
    platform?: string;
    workingDir?: string;
    resultBudgetChars?: number;
    /**
     * Hard cap on total tool calls per user turn (across all LLM iterations).
     * Defaults to 20. Trips a `tool_progress` warning and exits cleanly.
     * See plan/IMPROVEMENT.md P1-3.
     */
    maxToolCallsPerTurn?: number;
    /**
     * Hard cap on the number of times the same tool name can be invoked in a
     * single turn. Catches the "infinite loop on a single tool" failure mode
     * (e.g. tts loop reported as OpenClaw #67744). Defaults to 5.
     */
    maxIdenticalToolCalls?: number;
    /**
     * Default streaming watchdog in milliseconds. If no chunk arrives from the
     * LLM within this window, the agent aborts the stream and emits an error.
     * Reset on every chunk. Personalities can override via
     * `personality.streamingTimeoutMs`. Defaults to 120000 (2 minutes).
     */
    streamingTimeoutMs?: number;
  };
}

export interface RunOptions {
  sessionKey?: string;
  personalityId?: string;
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private readonly llm: LLMProvider;
  private readonly tools: ToolRegistry;
  private readonly personalities: PersonalityRegistry;
  private readonly memory: MemoryProvider;
  private readonly session: SessionStore;
  private readonly hooks: HookRegistry;
  private readonly injectors: ContextInjector[];
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly platform: string;
  private readonly workingDir: string;
  private readonly resultBudgetChars: number;
  private readonly maxToolCallsPerTurn: number;
  private readonly maxIdenticalToolCalls: number;
  private readonly streamingTimeoutMs: number;
  private readonly modelRouting: Record<string, string>;

  constructor(config: AgentLoopConfig) {
    this.llm = config.llm;
    this.tools = config.tools ?? new DefaultToolRegistry();
    this.personalities = config.personalities ?? new DefaultPersonalityRegistry();
    this.memory = config.memory ?? new NoopMemoryProvider();
    this.session = config.session ?? new InMemorySessionStore();
    this.hooks = config.hooks ?? new DefaultHookRegistry();
    this.injectors = (config.injectors ?? []).sort((a, b) => b.priority - a.priority);
    this.maxIterations = config.options?.maxIterations ?? 50;
    this.historyLimit = config.options?.historyLimit ?? 200;
    this.platform = config.options?.platform ?? 'cli';
    this.workingDir = config.options?.workingDir ?? process.cwd();
    this.resultBudgetChars = config.options?.resultBudgetChars ?? 80_000;
    this.maxToolCallsPerTurn = config.options?.maxToolCallsPerTurn ?? 20;
    this.maxIdenticalToolCalls = config.options?.maxIdenticalToolCalls ?? 5;
    this.streamingTimeoutMs = config.options?.streamingTimeoutMs ?? 120_000;
    this.modelRouting = config.modelRouting ?? {};
  }

  async *run(text: string, opts: RunOptions = {}): AsyncGenerator<AgentEvent> {
    const abortSignal = opts.abortSignal ?? new AbortController().signal;
    const sessionKey = opts.sessionKey ?? `${this.platform}:default`;

    // Step 1: Resolve or create session
    const ethosSession =
      (await this.session.getSessionByKey(sessionKey)) ??
      (await this.session.createSession({
        key: sessionKey,
        platform: this.platform,
        model: this.llm.model,
        provider: this.llm.name,
        personalityId: opts.personalityId,
        workingDir: this.workingDir,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
          apiCallCount: 0,
          compactionCount: 0,
        },
      }));

    const sessionId = ethosSession.id;
    const personality =
      (opts.personalityId ? this.personalities.get(opts.personalityId) : null) ??
      this.personalities.getDefault();

    // Resolve effective model: explicit per-personality routing > LLM base model.
    // personality.model is intentionally skipped — those IDs are Anthropic-specific
    // and break non-Anthropic providers (OpenRouter, Gemini, Ollama, etc.).
    // Configure overrides via modelRouting in ~/.ethos/config.yaml instead.
    const effectiveModel = this.modelRouting[personality.id] ?? this.llm.model;
    const modelOverride = effectiveModel !== this.llm.model ? effectiveModel : undefined;
    // Allowed tool names for this personality (undefined = no restriction)
    const allowedTools = personality.toolset?.length ? personality.toolset : undefined;

    // Step 2: Fire session_start hooks
    await this.hooks.fireVoid('session_start', {
      sessionId,
      sessionKey,
      platform: this.platform,
      personalityId: personality.id,
    });

    // Step 3: Persist the user message
    await this.session.appendMessage({
      sessionId,
      role: 'user',
      content: text,
    });

    // Step 4: Load history (trimmed to most-recent limit)
    const allMessages = await this.session.getMessages(sessionId, { limit: this.historyLimit });
    const history = allMessages.filter((m) => m.role !== 'system');

    // Step 5: Prefetch memory
    const memCtx = await this.memory.prefetch({
      sessionId,
      sessionKey,
      platform: this.platform,
      workingDir: this.workingDir,
      personalityId: personality.id,
      memoryScope: personality.memoryScope,
      query: text,
    });

    // Step 6: Build system prompt from injectors
    const promptCtx: PromptContext = {
      sessionId,
      sessionKey,
      platform: this.platform,
      model: this.llm.model,
      history,
      workingDir: this.workingDir,
      isDm: true,
      turnNumber: allMessages.length,
      personalityId: personality.id,
    };

    const systemParts: string[] = [];

    // ETHOS.md / personality identity
    if (personality.ethosFile) {
      try {
        const fs = await import('node:fs/promises');
        const identity = await fs.readFile(personality.ethosFile, 'utf-8');
        systemParts.push(identity.trim());
      } catch {
        // ethosFile not readable — skip
      }
    }

    // Context injectors sorted by priority (already sorted in constructor)
    for (const injector of this.injectors) {
      if (injector.shouldInject && !injector.shouldInject(promptCtx)) continue;
      const result = await injector.inject(promptCtx);
      if (result) {
        if (result.position === 'prepend') {
          systemParts.unshift(result.content);
        } else {
          systemParts.push(result.content);
        }
      }
    }

    // Emit injector metadata (e.g. skill_files_used) so eval harness can capture it.
    if (promptCtx.meta && Object.keys(promptCtx.meta).length > 0) {
      yield { type: 'context_meta', data: promptCtx.meta };
    }

    // Memory injected last, as context about the user
    if (memCtx) {
      systemParts.push(`## Memory\n\n${memCtx.content}`);
    }

    // Step 7: Before-prompt-build modifying hooks (plugins can prepend/append/override)
    const buildResult = await this.hooks.fireModifying('before_prompt_build', {
      sessionId,
      personalityId: personality.id,
      history,
    });

    if (buildResult.overrideSystem) {
      systemParts.length = 0;
      systemParts.push(buildResult.overrideSystem);
    } else {
      if (buildResult.prependSystem) systemParts.unshift(buildResult.prependSystem);
      if (buildResult.appendSystem) systemParts.push(buildResult.appendSystem);
    }

    const systemPrompt = systemParts.join('\n\n').trim() || undefined;

    // Step 8: Agentic loop — LLM call → tool use → LLM call → ...
    const llmMessages = this.toLLMMessages(history);
    let fullText = '';
    let turnCount = 0;

    // Tool-call budget tracking — prevents runaway loops (see IMPROVEMENT.md P1-3).
    // Counted across all iterations within a single user turn.
    let totalToolCalls = 0;
    const toolNameCounts = new Map<string, number>();

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (abortSignal.aborted) {
        yield { type: 'error', error: 'Aborted', code: 'aborted' };
        return;
      }

      // Budget guard: bail before the next LLM call if we've already exceeded
      // either the total tool-call budget or the per-tool repeat budget. The
      // previous iteration's tool_result is in llmMessages, so the LLM history
      // stays valid; we just refuse to call again.
      if (totalToolCalls >= this.maxToolCallsPerTurn) {
        yield {
          type: 'tool_progress',
          toolName: '_budget',
          message: `Stopped: hit ${this.maxToolCallsPerTurn}-tool-call budget for this turn`,
        };
        break;
      }
      const overusedTool = [...toolNameCounts.entries()].find(
        ([, count]) => count >= this.maxIdenticalToolCalls,
      );
      if (overusedTool) {
        yield {
          type: 'tool_progress',
          toolName: overusedTool[0],
          message: `Stopped: ${overusedTool[0]} called ${overusedTool[1]} times in one turn (likely loop)`,
        };
        break;
      }

      // Fire before_llm_call
      await this.hooks.fireVoid('before_llm_call', {
        sessionId,
        model: this.llm.model,
        turnNumber: turnCount,
      });

      // Stream LLM response
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        partialJson: string;
        args?: unknown;
      }> = [];
      let chunkText = '';

      // Streaming watchdog: cancel the stream if no chunk arrives within the
      // per-personality window. Reset every chunk so slow-but-progressing
      // reasoning is unaffected. See IMPROVEMENT.md P1-2 / OpenClaw #68596.
      const watchdogMs = personality.streamingTimeoutMs ?? this.streamingTimeoutMs;
      const watchdogController = new AbortController();
      const combinedSignal = AbortSignal.any([abortSignal, watchdogController.signal]);
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => watchdogController.abort(), watchdogMs);
      };
      const disarmWatchdog = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      };

      try {
        armWatchdog();
        const stream = this.llm.complete(llmMessages, this.tools.toDefinitions(allowedTools), {
          system: systemPrompt,
          cacheSystemPrompt: true,
          abortSignal: combinedSignal,
          ...(modelOverride ? { modelOverride } : {}),
        });

        for await (const chunk of stream) {
          if (abortSignal.aborted) break;
          if (watchdogController.signal.aborted) break;
          armWatchdog();
          yield* this.handleChunk(chunk, pendingToolCalls, (t) => {
            chunkText += t;
            fullText += t;
          });
        }
        disarmWatchdog();

        if (watchdogController.signal.aborted && !abortSignal.aborted) {
          yield {
            type: 'error',
            error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
            code: 'streaming_timeout',
          };
          return;
        }
      } catch (err) {
        disarmWatchdog();
        if (watchdogController.signal.aborted && !abortSignal.aborted) {
          yield {
            type: 'error',
            error: `LLM stream stalled — no chunk for ${watchdogMs}ms`,
            code: 'streaming_timeout',
          };
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', error: msg, code: 'llm_error' };
        return;
      }

      turnCount++;

      // Determine which tool calls completed parsing
      const completedToolCalls = pendingToolCalls.filter((tc) => tc.args !== undefined);

      // Update budget counters — these gate the NEXT iteration's LLM call.
      totalToolCalls += completedToolCalls.length;
      for (const tc of completedToolCalls) {
        toolNameCounts.set(tc.toolName, (toolNameCounts.get(tc.toolName) ?? 0) + 1);
      }

      // Persist assistant message — include tool_use references so history is LLM-replayable
      await this.session.appendMessage({
        sessionId,
        role: 'assistant',
        content: chunkText,
        ...(completedToolCalls.length > 0 && {
          toolCalls: completedToolCalls.map((tc) => ({
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.args,
          })),
        }),
      });

      // Fire after_llm_call
      await this.hooks.fireVoid('after_llm_call', {
        sessionId,
        text: chunkText,
        usage: { inputTokens: 0, outputTokens: 0 },
      });

      // Push assistant message with proper content blocks for next iteration
      if (completedToolCalls.length > 0) {
        const assistantContent: MessageContent[] = [];
        if (chunkText) assistantContent.push({ type: 'text', text: chunkText });
        for (const tc of completedToolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.args,
          });
        }
        llmMessages.push({ role: 'assistant', content: assistantContent });
      } else {
        llmMessages.push({ role: 'assistant', content: chunkText });
        break;
      }

      // Step 9: Pre-flight hooks → execute non-rejected tools → collect all results
      const toolCtxBase = {
        sessionId,
        sessionKey,
        platform: this.platform,
        workingDir: this.workingDir,
        personalityId: personality.id,
        memoryScope: personality.memoryScope,
        currentTurn: turnCount,
        messageCount: allMessages.length + turnCount,
        abortSignal,
        emit: (_event: {
          type: 'progress';
          toolName: string;
          message: string;
          percent?: number;
        }) => {
          // Progress emission wired in Phase 6 (terminal streaming)
        },
        resultBudgetChars: this.resultBudgetChars,
      };

      // Run before_tool_call hooks; build exec list with effective args
      // Rejected tools get tool_end ok:false + an error tool_result sent back to LLM
      type Prepped = { toolCallId: string; name: string; args: unknown; rejected?: string };
      const prepped: Prepped[] = [];

      for (const tc of completedToolCalls) {
        const beforeResult = await this.hooks.fireModifying('before_tool_call', {
          sessionId,
          toolName: tc.toolName,
          args: tc.args,
        });

        if (beforeResult.error) {
          yield {
            type: 'tool_end',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            ok: false,
            durationMs: 0,
          };
          prepped.push({
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            args: tc.args,
            rejected: beforeResult.error,
          });
          continue;
        }

        const effectiveArgs = beforeResult.args ?? tc.args;
        yield {
          type: 'tool_start',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: effectiveArgs,
        };
        prepped.push({ toolCallId: tc.toolCallId, name: tc.toolName, args: effectiveArgs });
      }

      // Execute only non-rejected tools; results keyed by toolCallId
      const execInputs = prepped
        .filter((p) => p.rejected === undefined)
        .map((p) => ({ toolCallId: p.toolCallId, name: p.name, args: p.args }));

      const startedAt = Date.now();
      const execResults =
        execInputs.length > 0
          ? await this.tools.executeParallel(execInputs, toolCtxBase, allowedTools)
          : [];
      const execResultMap = new Map(execResults.map((r) => [r.toolCallId, r]));

      // Persist results + emit tool_end + build tool_result content blocks (original order)
      const toolResultContent: MessageContent[] = [];

      for (const p of prepped) {
        const durationMs = Date.now() - startedAt;
        let result: ToolResult;

        if (p.rejected !== undefined) {
          result = { ok: false, error: p.rejected, code: 'execution_failed' };
          // tool_end already emitted above; no after_tool_call hook for blocked tools
        } else {
          const execResult = execResultMap.get(p.toolCallId);
          result = execResult?.result ?? {
            ok: false,
            error: 'Tool result missing',
            code: 'execution_failed',
          };
          yield {
            type: 'tool_end',
            toolCallId: p.toolCallId,
            toolName: p.name,
            ok: result.ok,
            durationMs,
          };
          await this.hooks.fireVoid('after_tool_call', {
            sessionId,
            toolName: p.name,
            result,
            durationMs,
          });
        }

        // Persist every result (rejected or not) so history matches what LLM sees
        await this.session.appendMessage({
          sessionId,
          role: 'tool_result',
          content: result.ok ? result.value : result.error,
          toolCallId: p.toolCallId,
          toolName: p.name,
        });

        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: p.toolCallId,
          content: result.ok ? result.value : result.error,
          is_error: !result.ok,
        });
      }

      // Feed all tool results back to LLM as a single user message with content blocks
      llmMessages.push({ role: 'user', content: toolResultContent });
    }

    // Step 10: Sync memory
    await this.memory.sync(
      {
        sessionId,
        sessionKey,
        platform: this.platform,
        workingDir: this.workingDir,
        personalityId: personality.id,
        memoryScope: personality.memoryScope,
      },
      [],
    );

    // Step 11: Update usage
    await this.session.updateUsage(sessionId, { apiCallCount: turnCount });

    // Step 12: Fire agent_done
    await this.hooks.fireVoid('agent_done', { sessionId, text: fullText, turnCount });

    yield { type: 'done', text: fullText, turnCount };
  }

  private *handleChunk(
    chunk: CompletionChunk,
    pendingToolCalls: Array<{
      toolCallId: string;
      toolName: string;
      partialJson: string;
      args?: unknown;
    }>,
    onText: (t: string) => void,
  ): Generator<AgentEvent> {
    switch (chunk.type) {
      case 'text_delta':
        onText(chunk.text);
        yield { type: 'text_delta', text: chunk.text };
        break;

      case 'thinking_delta':
        yield { type: 'thinking_delta', thinking: chunk.thinking };
        break;

      case 'tool_use_start':
        pendingToolCalls.push({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          partialJson: '',
        });
        break;

      case 'tool_use_delta': {
        const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
        if (tc) tc.partialJson += chunk.partialJson;
        break;
      }

      case 'tool_use_end': {
        const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
        if (tc) {
          try {
            tc.args = JSON.parse(chunk.inputJson || tc.partialJson);
          } catch {
            tc.args = {};
          }
        }
        break;
      }

      case 'usage':
        yield {
          type: 'usage',
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          estimatedCostUsd: chunk.usage.estimatedCostUsd,
        };
        break;

      case 'done':
        // finishReason available here for future context-compaction (Phase 3)
        break;
    }
  }

  // Reconstruct LLM-ready messages from stored history.
  // Assistant messages with tool calls produce proper tool_use content blocks.
  // Consecutive tool_result rows are grouped into a single user message.
  private toLLMMessages(stored: StoredMessage[]): Message[] {
    const messages: Message[] = [];

    for (const msg of stored) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: MessageContent[] = [];
          if (msg.content) content.push({ type: 'text', text: msg.content });
          for (const tc of msg.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          }
          messages.push({ role: 'assistant', content });
        } else {
          messages.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool_result') {
        const resultBlock: MessageContent = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: msg.content,
          is_error: false,
        };
        const last = messages[messages.length - 1];
        // Append to existing tool_result user message, or start a new one
        if (last?.role === 'user' && Array.isArray(last.content)) {
          (last.content as MessageContent[]).push(resultBlock);
        } else {
          messages.push({ role: 'user', content: [resultBlock] });
        }
      }
    }

    return messages;
  }
}
