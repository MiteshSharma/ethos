// Context-economy Phase 1 (§3.5) — tool-definition stability, locked in.
//
// Contract: the tool list the LLM sees is STATIC PER TURN — set by the
// personality toolset and, optionally, a static per-channel `toolsetNarrow`
// resolved once from config. Nothing may mutate the tool list between turns:
// on cache-priced providers the tool schemas serialize AHEAD of system in the
// cache prefix, so a per-turn list change invalidates tools + system + history
// caching in one stroke. This guard proves per-turn tool-list mutation was not
// quietly reintroduced (the invariant the "no runtime tool router" decision
// buys us). Sibling of prompt-prefix-stability.test.ts, which guards the
// system prompt half.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  Tool,
  ToolDefinitionLite,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
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
    maxContextTokens: 200_000,
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

function makeTool(name: string): Tool {
  return {
    name,
    description: `fake tool ${name}`,
    schema: {},
    toolset: 'test',
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }) as ToolResult,
  };
}

function makeRegistry(): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
    registry.register(makeTool(name));
  }
  return registry;
}

const PERSONALITY_TOOLSET = ['alpha', 'beta', 'gamma'];

function makePersonalities() {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'lean',
    name: 'Lean',
    toolset: PERSONALITY_TOOLSET,
  });
  return personalities;
}

async function runTwoTurns(
  toolsetNarrow?: string[],
  toolsetExclude?: string[],
): Promise<{ first: ToolDefinitionLite[]; second: ToolDefinitionLite[] }> {
  const capturedTools: ToolDefinitionLite[][] = [];
  const loop = new AgentLoop({
    llm: capturingLLM(capturedTools),
    tools: makeRegistry(),
    personalities: makePersonalities(),
    safety: createTestSafety(),
  });
  const opts = {
    ...(toolsetNarrow ? { toolsetNarrow } : {}),
    ...(toolsetExclude ? { toolsetExclude } : {}),
  };
  await collect(loop.run('hello', opts));
  await collect(loop.run('hello', opts));
  expect(capturedTools).toHaveLength(2);
  return { first: capturedTools[0] ?? [], second: capturedTools[1] ?? [] };
}

describe('§3.5 — tool-definition stability across turns', () => {
  it('personality toolset only: tool definitions are byte-identical across turns', async () => {
    const { first, second } = await runTwoTurns();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((d) => d.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('with a static toolsetNarrow: byte-identical across turns, intersection only', async () => {
    // `delta` is outside the personality toolset — narrow can only shrink,
    // never widen, so it must not appear.
    const { first, second } = await runTwoTurns(['beta', 'gamma', 'delta']);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((d) => d.name).sort()).toEqual(['beta', 'gamma']);
  });

  it('with a static toolsetExclude: byte-identical across turns, subtraction only', async () => {
    // Surface exclusion (the gateway's UI-card drop) is static per surface, so
    // it subtracts once and never varies per turn.
    const { first, second } = await runTwoTurns(undefined, ['beta']);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((d) => d.name).sort()).toEqual(['alpha', 'gamma']);
  });

  it('toolsetNarrow and toolsetExclude compose without per-turn drift', async () => {
    const { first, second } = await runTwoTurns(['beta', 'gamma', 'delta'], ['gamma']);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((d) => d.name).sort()).toEqual(['beta']);
  });
});
