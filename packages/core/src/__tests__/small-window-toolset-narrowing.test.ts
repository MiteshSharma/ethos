// Lane 3(b) / eng review D20 — declared small-window toolset narrowing.
//
// When wiring resolves small-window mode (options.smallWindow) AND the turn
// personality declares `context_engine_options.small_window_toolset`, the
// effective toolset narrows to the declared set. The narrowed set gates BOTH
// toDefinitions() — asserted on the serialized tool payload the provider
// receives, not on config — AND executeParallel's allowlist: a call to a
// narrowed-out tool is rejected exactly like a disallowed tool (an error
// tool_result with is_error, keeping the message contract intact). A
// personality declaring nothing keeps its full toolset.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  PersonalityConfig,
  Tool,
  ToolDefinitionLite,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { parseSmallWindowToolset } from '../agent-loop/small-window-toolset';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const _e of gen) out.push(_e);
  return out;
}

function capturingLLM(capturedTools: ToolDefinitionLite[][]): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens: 16_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: Message[],
      tools: ToolDefinitionLite[],
      _opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      capturedTools.push(tools);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** LLM that calls `toolName` on its first response, then ends the turn. */
function toolCallingLLM(toolName: string): LLMProvider {
  let call = 0;
  return {
    name: 'caller',
    model: 'mock-model',
    maxContextTokens: 16_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      call++;
      if (call === 1) {
        yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
        yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: `fake tool ${name}`,
    schema: {},
    toolset: 'test',
    capabilities: {},
    execute: async () => ({ ok: true, value: `${name} ran` }) as ToolResult,
  };
}

function makeRegistry(): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) registry.register(makeTool(name));
  return registry;
}

function makePersonalities(personality: PersonalityConfig) {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue(personality);
  return personalities;
}

const DECLARING: PersonalityConfig = {
  id: 'lean',
  name: 'Lean',
  toolset: ['alpha', 'beta', 'gamma'],
  context_engine_options: { small_window_toolset: 'alpha, beta' },
};

const NOT_DECLARING: PersonalityConfig = {
  id: 'full',
  name: 'Full',
  toolset: ['alpha', 'beta', 'gamma'],
};

function makeLoop(
  llm: LLMProvider,
  personality: PersonalityConfig,
  smallWindow: boolean,
): AgentLoop {
  return new AgentLoop({
    llm,
    tools: makeRegistry(),
    personalities: makePersonalities(personality),
    safety: createTestSafety(),
    options: smallWindow ? { smallWindow: true } : {},
  });
}

describe('parseSmallWindowToolset', () => {
  it('parses a comma-separated string (the flat config.yaml shape)', () => {
    expect(parseSmallWindowToolset('alpha, beta ,gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('parses a string array (programmatic personalities)', () => {
    expect(parseSmallWindowToolset(['alpha', 'beta'])).toEqual(['alpha', 'beta']);
  });

  it('rejects absent, malformed, and empty values', () => {
    expect(parseSmallWindowToolset(undefined)).toBeUndefined();
    expect(parseSmallWindowToolset(42)).toBeUndefined();
    expect(parseSmallWindowToolset('')).toBeUndefined();
    expect(parseSmallWindowToolset([1, 2])).toBeUndefined();
    expect(parseSmallWindowToolset(' , ')).toBeUndefined();
  });
});

describe('Lane 3(b)/D20 — declared small-window toolset narrowing', () => {
  it('narrows the SERIALIZED tool payload to the declared set when small-window is active', async () => {
    const captured: ToolDefinitionLite[][] = [];
    const loop = makeLoop(capturingLLM(captured), DECLARING, true);
    await collect(loop.run('hello', {}));
    expect(captured).toHaveLength(1);
    expect((captured[0] ?? []).map((d) => d.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('a personality declaring nothing keeps its full toolset in the payload', async () => {
    const captured: ToolDefinitionLite[][] = [];
    const loop = makeLoop(capturingLLM(captured), NOT_DECLARING, true);
    await collect(loop.run('hello', {}));
    expect((captured[0] ?? []).map((d) => d.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('without small-window mode the declaration is inert', async () => {
    const captured: ToolDefinitionLite[][] = [];
    const loop = makeLoop(capturingLLM(captured), DECLARING, false);
    await collect(loop.run('hello', {}));
    expect((captured[0] ?? []).map((d) => d.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('the declaration can never escalate beyond the personality toolset', async () => {
    const captured: ToolDefinitionLite[][] = [];
    const loop = makeLoop(
      capturingLLM(captured),
      {
        ...DECLARING,
        context_engine_options: { small_window_toolset: 'alpha, delta' },
      },
      true,
    );
    await collect(loop.run('hello', {}));
    // `delta` is outside the personality toolset — declared or not, it never
    // reaches the payload.
    expect((captured[0] ?? []).map((d) => d.name).sort()).toEqual(['alpha']);
  });

  it('a call to a narrowed-out tool is rejected like a disallowed tool', async () => {
    // `gamma` is in the personality toolset but NOT in the declared
    // small-window set — executeParallel must reject it (D20: the narrowed
    // set is the effective toolset, not a display filter).
    const loop = makeLoop(toolCallingLLM('gamma'), DECLARING, true);
    const events = await collect(loop.run('call gamma', {}));
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toBeDefined();
    expect(toolEnd?.type === 'tool_end' && toolEnd.ok).toBe(false);
  });

  it('the same call succeeds when small-window mode is off', async () => {
    const loop = makeLoop(toolCallingLLM('gamma'), DECLARING, false);
    const events = await collect(loop.run('call gamma', {}));
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd?.type === 'tool_end' && toolEnd.ok).toBe(true);
  });
});
