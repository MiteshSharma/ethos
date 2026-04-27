import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionChunk, CompletionOptions, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';

function makeMockLLM(
  responses: string[],
  onComplete?: (opts: CompletionOptions) => void,
): LLMProvider {
  let callCount = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      _tools: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      onComplete?.(opts);
      const text = responses[callCount++ % responses.length] ?? 'default response';
      yield { type: 'text_delta', text };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.0001,
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('AgentLoop', () => {
  it('produces text_delta and done events for a simple turn', async () => {
    const loop = new AgentLoop({ llm: makeMockLLM(['Hello, world!']) });
    const events = await collect(loop.run('hi'));

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const done = events.find((e) => e.type === 'done');

    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as Extract<AgentEvent, { type: 'text_delta' }>).text).toBe(
      'Hello, world!',
    );
    expect(done).toBeDefined();
    expect((done as Extract<AgentEvent, { type: 'done' }>).turnCount).toBe(1);
  });

  it('accumulates full text in done event', async () => {
    const loop = new AgentLoop({ llm: makeMockLLM(['response text']) });
    const events = await collect(loop.run('ping'));
    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done.text).toBe('response text');
  });

  it('aborts cleanly when signal is fired', async () => {
    const controller = new AbortController();
    const loop = new AgentLoop({ llm: makeMockLLM(['text']) });

    // Abort before run
    controller.abort();
    const events = await collect(loop.run('hello', { abortSignal: controller.signal }));
    const errEvent = events.find((e) => e.type === 'error') as
      | Extract<AgentEvent, { type: 'error' }>
      | undefined;
    expect(errEvent?.code).toBe('aborted');
  });

  it('passes modelOverride when modelRouting matches the personality', async () => {
    const capturedOpts: CompletionOptions[] = [];
    const llm = makeMockLLM(['ok'], (opts) => capturedOpts.push(opts));
    const loop = new AgentLoop({
      llm,
      modelRouting: { default: 'routed-model' },
    });
    await collect(loop.run('hi'));
    expect(capturedOpts[0]?.modelOverride).toBe('routed-model');
  });

  it('passes no modelOverride when routing matches the base model', async () => {
    const capturedOpts: CompletionOptions[] = [];
    const llm = makeMockLLM(['ok'], (opts) => capturedOpts.push(opts));
    const loop = new AgentLoop({
      llm,
      modelRouting: { default: 'mock-model' }, // same as llm.model
    });
    await collect(loop.run('hi'));
    expect(capturedOpts[0]?.modelOverride).toBeUndefined();
  });

  it('passes no modelOverride when no routing is configured', async () => {
    const capturedOpts: CompletionOptions[] = [];
    const llm = makeMockLLM(['ok'], (opts) => capturedOpts.push(opts));
    const loop = new AgentLoop({ llm });
    await collect(loop.run('hi'));
    expect(capturedOpts[0]?.modelOverride).toBeUndefined();
  });

  it('passes filtered tool definitions when personality has a toolset', async () => {
    const capturedTools: unknown[][] = [];
    const llm: LLMProvider = {
      name: 'mock',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(_messages: Message[], tools: unknown[]): AsyncIterable<CompletionChunk> {
        capturedTools.push(tools);
        yield { type: 'text_delta', text: 'done' };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0,
          },
        };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };

    const { DefaultToolRegistry } = await import('../tool-registry');
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'allowed_tool',
      description: 'allowed',
      schema: { type: 'object' },
      execute: async () => ({ ok: true, value: '' }),
    });
    tools.register({
      name: 'blocked_tool',
      description: 'blocked',
      schema: { type: 'object' },
      execute: async () => ({ ok: true, value: '' }),
    });

    // Override the default personality to have a toolset
    const { DefaultPersonalityRegistry } = await import('../defaults/noop-personality');
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'default',
      name: 'Default',
      toolset: ['allowed_tool'],
    });

    const loop = new AgentLoop({ llm, tools, personalities });
    await collect(loop.run('hi'));

    expect(capturedTools[0]).toHaveLength(1);
    expect((capturedTools[0] as Array<{ name: string }>)[0]?.name).toBe('allowed_tool');
  });

  // Tool-call budget — see plan/IMPROVEMENT.md P1-3 and OpenClaw #67744 (275
  // identical messages in 10 minutes before context overflow). The loop must
  // bail BEFORE the next LLM call once a budget is exceeded.

  describe('tool-call budget guards', () => {
    function makeLoopingToolLLM(toolName: string, getCallCount: () => number): LLMProvider {
      return {
        name: 'mock',
        model: 'mock-model',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(): AsyncIterable<CompletionChunk> {
          const id = `call-${getCallCount()}`;
          yield { type: 'text_delta', text: 'looping...' };
          yield { type: 'tool_use_start', toolCallId: id, toolName };
          yield { type: 'tool_use_delta', toolCallId: id, partialJson: '{}' };
          yield { type: 'tool_use_end', toolCallId: id, inputJson: '{}' };
          yield {
            type: 'usage',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              estimatedCostUsd: 0,
            },
          };
          yield { type: 'done', finishReason: 'tool_use' };
        },
        async countTokens() {
          return 1;
        },
      };
    }

    async function buildRegistry(toolName: string) {
      const { DefaultToolRegistry } = await import('../tool-registry');
      const tools = new DefaultToolRegistry();
      tools.register({
        name: toolName,
        description: 'looping tool',
        schema: { type: 'object' },
        execute: async () => ({ ok: true, value: 'ran' }),
      });
      return tools;
    }

    it('breaks before exceeding maxToolCallsPerTurn', async () => {
      let llmCallCount = 0;
      const llm: LLMProvider = {
        ...makeLoopingToolLLM('repeat_me', () => llmCallCount),
        async *complete(): AsyncIterable<CompletionChunk> {
          llmCallCount++;
          // Each iteration emits a DIFFERENT tool name to dodge the identical-call cap,
          // so we test the total budget specifically. Use llmCallCount to vary.
          const id = `call-${llmCallCount}`;
          const tname = `tool_${llmCallCount}`;
          yield { type: 'tool_use_start', toolCallId: id, toolName: tname };
          yield { type: 'tool_use_delta', toolCallId: id, partialJson: '{}' };
          yield { type: 'tool_use_end', toolCallId: id, inputJson: '{}' };
          yield { type: 'done', finishReason: 'tool_use' };
        },
        async countTokens() {
          return 1;
        },
      };
      // Register a generic catch-all by registering several
      const { DefaultToolRegistry } = await import('../tool-registry');
      const tools = new DefaultToolRegistry();
      for (let i = 1; i <= 10; i++) {
        tools.register({
          name: `tool_${i}`,
          description: `t${i}`,
          schema: { type: 'object' },
          execute: async () => ({ ok: true, value: 'ran' }),
        });
      }

      const loop = new AgentLoop({
        llm,
        tools,
        options: { maxToolCallsPerTurn: 3, maxIdenticalToolCalls: 100 },
      });
      const events = await collect(loop.run('hi'));

      const progress = events.find((e) => e.type === 'tool_progress') as
        | Extract<AgentEvent, { type: 'tool_progress' }>
        | undefined;
      expect(progress?.message).toMatch(/tool-call budget/);
      expect(llmCallCount).toBeLessThanOrEqual(4);
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    it('breaks before exceeding maxIdenticalToolCalls', async () => {
      let llmCallCount = 0;
      const tools = await buildRegistry('repeat_me');
      const llm = makeLoopingToolLLM('repeat_me', () => {
        llmCallCount++;
        return llmCallCount;
      });

      const loop = new AgentLoop({
        llm,
        tools,
        options: { maxToolCallsPerTurn: 100, maxIdenticalToolCalls: 3 },
      });
      const events = await collect(loop.run('hi'));

      const progress = events.find((e) => e.type === 'tool_progress') as
        | Extract<AgentEvent, { type: 'tool_progress' }>
        | undefined;
      expect(progress?.toolName).toBe('repeat_me');
      expect(progress?.message).toMatch(/repeat_me called \d+ times/);
      expect(llmCallCount).toBeLessThanOrEqual(4);
      expect(events.find((e) => e.type === 'done')).toBeDefined();
    });

    it('streaming watchdog fires when no chunk arrives within timeout', async () => {
      // A provider that hangs forever — never yields. Watchdog must trip.
      const hangingLlm: LLMProvider = {
        name: 'hanging',
        model: 'mock-model',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(
          _messages: Message[],
          _tools: unknown,
          opts: CompletionOptions,
        ): AsyncIterable<CompletionChunk> {
          // Wait until aborted — or 30s, whichever comes first (test safety)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            opts.abortSignal?.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          });
          // If we got here without abort, yield nothing — closes the stream.
        },
        async countTokens() {
          return 1;
        },
      };

      const loop = new AgentLoop({
        llm: hangingLlm,
        options: { streamingTimeoutMs: 50 },
      });
      const events = await collect(loop.run('hi'));
      const err = events.find((e) => e.type === 'error') as
        | Extract<AgentEvent, { type: 'error' }>
        | undefined;
      expect(err?.code).toBe('streaming_timeout');
      expect(err?.error).toMatch(/stalled/);
    });

    it('streaming watchdog respects per-personality streamingTimeoutMs override', async () => {
      // Personality says 30ms, AgentLoop default is 120000ms — personality wins.
      const hangingLlm: LLMProvider = {
        name: 'hanging',
        model: 'mock-model',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(
          _messages: Message[],
          _tools: unknown,
          opts: CompletionOptions,
        ): AsyncIterable<CompletionChunk> {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            opts.abortSignal?.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        },
        async countTokens() {
          return 1;
        },
      };

      const { DefaultPersonalityRegistry } = await import('../defaults/noop-personality');
      const personalities = new DefaultPersonalityRegistry();
      vi.spyOn(personalities, 'getDefault').mockReturnValue({
        id: 'fast',
        name: 'Fast',
        streamingTimeoutMs: 30,
      });

      const start = Date.now();
      const loop = new AgentLoop({ llm: hangingLlm, personalities });
      const events = await collect(loop.run('hi'));
      const elapsed = Date.now() - start;

      const err = events.find((e) => e.type === 'error') as
        | Extract<AgentEvent, { type: 'error' }>
        | undefined;
      expect(err?.code).toBe('streaming_timeout');
      // Should fire near the personality's 30ms threshold, not the loop default
      expect(elapsed).toBeLessThan(2000);
    });

    // Provider boundary contract — see plan/IMPROVEMENT.md P0-2.
    // AgentLoop must never import a provider SDK. If it does, every model
    // upgrade pulls in a leak (Anthropic thinking shape, OpenAI tool index
    // keying, etc.). The boundary lives in the LLMProvider interface; this
    // test ensures we do not erode it.
    it('AgentLoop source does not import any concrete LLM SDK', () => {
      const src = readFileSync(join(__dirname, '..', 'agent-loop.ts'), 'utf-8');
      expect(src).not.toMatch(/from ['"]@anthropic-ai\/sdk['"]/);
      expect(src).not.toMatch(/from ['"]openai['"]/);
      expect(src).not.toMatch(/from ['"]@ethosagent\/llm-/);
    });

    it('does not break when tool calls stay under both budgets', async () => {
      // LLM that calls a tool once then ends with text
      let stage = 0;
      const llm: LLMProvider = {
        name: 'mock',
        model: 'mock-model',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(): AsyncIterable<CompletionChunk> {
          stage++;
          if (stage === 1) {
            yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'once' };
            yield { type: 'tool_use_delta', toolCallId: 'c1', partialJson: '{}' };
            yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
            yield { type: 'done', finishReason: 'tool_use' };
          } else {
            yield { type: 'text_delta', text: 'all done' };
            yield { type: 'done', finishReason: 'end_turn' };
          }
        },
        async countTokens() {
          return 1;
        },
      };
      const tools = await buildRegistry('once');
      const loop = new AgentLoop({
        llm,
        tools,
        options: { maxToolCallsPerTurn: 20, maxIdenticalToolCalls: 5 },
      });
      const events = await collect(loop.run('hi'));
      expect(events.find((e) => e.type === 'tool_progress')).toBeUndefined();
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.text).toContain('all done');
    });

    it('budget tripping emits tool_progress with audience: user', async () => {
      let llmCallCount = 0;
      const llm: LLMProvider = {
        ...makeLoopingToolLLM('repeat_me', () => llmCallCount),
        async *complete(): AsyncIterable<CompletionChunk> {
          llmCallCount++;
          yield { type: 'tool_use_start', toolCallId: `c${llmCallCount}`, toolName: 'repeat_me' };
          yield { type: 'tool_use_end', toolCallId: `c${llmCallCount}`, inputJson: '{}' };
          yield { type: 'done', finishReason: 'tool_use' };
        },
        async countTokens() {
          return 1;
        },
      };
      const tools = await buildRegistry('repeat_me');
      const loop = new AgentLoop({
        llm,
        tools,
        options: { maxToolCallsPerTurn: 100, maxIdenticalToolCalls: 2 },
      });
      const events = await collect(loop.run('hi'));
      const progress = events.find((e) => e.type === 'tool_progress') as
        | Extract<AgentEvent, { type: 'tool_progress' }>
        | undefined;
      expect(progress).toBeDefined();
      expect(progress?.audience).toBe('user');
    });
  });

  describe('Phase 30.2: tool-emitted progress audience', () => {
    it('forwards ctx.emit() events as tool_progress, defaulting audience to internal', async () => {
      const { DefaultToolRegistry } = await import('../tool-registry');
      const tools = new DefaultToolRegistry();
      tools.register({
        name: 'emitter',
        description: 'emits a progress event with no audience tag',
        schema: { type: 'object' },
        execute: async (_args, ctx) => {
          ctx.emit({ type: 'progress', toolName: 'emitter', message: 'silent' });
          return { ok: true, value: 'done' };
        },
      });
      tools.register({
        name: 'emitter_user',
        description: 'emits a progress event tagged audience: user',
        schema: { type: 'object' },
        execute: async (_args, ctx) => {
          ctx.emit({
            type: 'progress',
            toolName: 'emitter_user',
            message: 'reading 1MB',
            audience: 'user',
          });
          return { ok: true, value: 'done' };
        },
      });

      // LLM emits two distinct tool_use blocks across two iterations, then ends.
      let call = 0;
      const llm: LLMProvider = {
        name: 'mock',
        model: 'mock-model',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(): AsyncIterable<CompletionChunk> {
          call++;
          if (call === 1) {
            yield { type: 'tool_use_start', toolCallId: 'a', toolName: 'emitter' };
            yield { type: 'tool_use_end', toolCallId: 'a', inputJson: '{}' };
            yield { type: 'done', finishReason: 'tool_use' };
          } else if (call === 2) {
            yield { type: 'tool_use_start', toolCallId: 'b', toolName: 'emitter_user' };
            yield { type: 'tool_use_end', toolCallId: 'b', inputJson: '{}' };
            yield { type: 'done', finishReason: 'tool_use' };
          } else {
            yield { type: 'text_delta', text: 'fin' };
            yield { type: 'done', finishReason: 'end_turn' };
          }
        },
        async countTokens() {
          return 1;
        },
      };

      const loop = new AgentLoop({ llm, tools });
      const events = await collect(loop.run('hi'));
      const progresses = events.filter((e) => e.type === 'tool_progress') as Array<
        Extract<AgentEvent, { type: 'tool_progress' }>
      >;
      // Untagged emit defaults to internal; tagged emit preserves 'user'.
      expect(progresses).toHaveLength(2);
      const silent = progresses.find((p) => p.toolName === 'emitter');
      const visible = progresses.find((p) => p.toolName === 'emitter_user');
      expect(silent?.audience).toBe('internal');
      expect(visible?.audience).toBe('user');
    });
  });
});
