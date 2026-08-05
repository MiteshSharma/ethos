// Item 7 stage 2 — `ContextEngine.onTurnComplete` is WIRED.
//
// `shouldCompact?()` is the cautionary precedent: declared, conformance-tested,
// and never called by the framework. The load-bearing assertion in this file is
// therefore not "an engine may declare the verb" but "the framework calls it" —
// driven through a real AgentLoop turn, not by invoking the hook directly.

import type {
  CompletionChunk,
  CompletionOptions,
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineTurnCompleteInput,
  ContextEngineTurnCompleteOutput,
  LLMProvider,
  Message,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { validateContextEngine } from '../context-engines/conformance';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createTestSafety } from './helpers/test-safety';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function mockLLM(): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: Message[],
      _t: unknown,
      _o: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** An engine that records every `onTurnComplete` call it receives. */
function recordingEngine(name = 'recording'): ContextEngine & {
  calls: ContextEngineTurnCompleteInput[];
} {
  const calls: ContextEngineTurnCompleteInput[] = [];
  return {
    calls,
    name,
    async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
      return { messages: opts.messages, notes: 'noop' };
    },
    async onTurnComplete(
      input: ContextEngineTurnCompleteInput,
    ): Promise<ContextEngineTurnCompleteOutput | null> {
      calls.push(input);
      return { notes: `saw turn ${input.sessionMetadata.turnNumber}` };
    },
  };
}

/** An engine that declares NO optional verbs — the optionality proof. */
function bareEngine(name: string): ContextEngine {
  return {
    name,
    async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
      return { messages: opts.messages, notes: 'noop' };
    },
  };
}

function personalities(engineName?: string) {
  const registry = new DefaultPersonalityRegistry();
  vi.spyOn(registry, 'getDefault').mockReturnValue({
    id: 'p',
    name: 'P',
    toolset: [],
    ...(engineName ? { context_engine: engineName } : {}),
  });
  return registry;
}

describe('Item 7 — ContextEngine.onTurnComplete is wired', () => {
  it('is called by the framework after a turn completes', async () => {
    const engine = recordingEngine();
    const contextEngines = new DefaultContextEngineRegistry();
    contextEngines.register(engine);

    const loop = new AgentLoop({
      llm: mockLLM(),
      safety: createTestSafety(),
      personalities: personalities(engine.name),
      contextEngines,
    });

    await collect(loop.run('hello'));

    expect(engine.calls).toHaveLength(1);
    const input = engine.calls[0];
    expect(input?.personality.id).toBe('p');
    expect(input?.sessionMetadata.sessionKey).toBeTruthy();
    // The hook sees the finished turn, so the user message is already in view.
    expect(JSON.stringify(input?.messages)).toContain('hello');
    expect(typeof input?.pressureRatio).toBe('number');
  });

  it('fires once per turn across a multi-turn session', async () => {
    const engine = recordingEngine();
    const contextEngines = new DefaultContextEngineRegistry();
    contextEngines.register(engine);
    const loop = new AgentLoop({
      llm: mockLLM(),
      safety: createTestSafety(),
      personalities: personalities(engine.name),
      contextEngines,
    });

    await collect(loop.run('one'));
    await collect(loop.run('two'));
    await collect(loop.run('three'));

    expect(engine.calls).toHaveLength(3);
  });

  it('still fires when turn-end auto-compaction and the memory flush are both off', async () => {
    const engine = recordingEngine();
    const contextEngines = new DefaultContextEngineRegistry();
    contextEngines.register(engine);
    const loop = new AgentLoop({
      llm: mockLLM(),
      safety: createTestSafety(),
      personalities: personalities(engine.name),
      contextEngines,
      compaction: { autoCompact: false },
    });

    await collect(loop.run('hello'));

    expect(engine.calls).toHaveLength(1);
  });

  it('runs the turn unchanged when the engine throws from the hook', async () => {
    const contextEngines = new DefaultContextEngineRegistry();
    contextEngines.register({
      name: 'thrower',
      async compact(opts) {
        return { messages: opts.messages, notes: 'noop' };
      },
      async onTurnComplete() {
        throw new Error('boom');
      },
    });
    const loop = new AgentLoop({
      llm: mockLLM(),
      safety: createTestSafety(),
      personalities: personalities('thrower'),
      contextEngines,
    });

    const events = await collect(loop.run('hello'));
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('runs every built-in engine and an external one without the method', async () => {
    const contextEngines = new DefaultContextEngineRegistry();
    const external = bareEngine('external_no_hook');
    contextEngines.register(external);
    // Four built-ins + the external engine, none implementing onTurnComplete.
    expect(contextEngines.names()).toEqual([
      'drop_oldest',
      'semantic_summary',
      'reference_preserving',
      'tiered_summary',
      'external_no_hook',
    ]);
    for (const name of contextEngines.names()) {
      expect(contextEngines.get(name)?.onTurnComplete).toBeUndefined();
    }

    for (const name of contextEngines.names()) {
      const loop = new AgentLoop({
        llm: mockLLM(),
        safety: createTestSafety(),
        personalities: personalities(name),
        contextEngines,
      });
      const events = await collect(loop.run('hello'));
      expect(events.some((e) => e.type === 'done')).toBe(true);
    }
  });
});

describe('Item 7 — conformance Scenario 6', () => {
  it('passes for an engine that implements onTurnComplete', async () => {
    const result = await validateContextEngine(recordingEngine());
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes for an engine that does not implement onTurnComplete', async () => {
    const result = await validateContextEngine(bareEngine('bare'));
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails an engine that nominates an id absent from the input', async () => {
    const result = await validateContextEngine({
      name: 'liar',
      async compact(opts) {
        return { messages: opts.messages, notes: 'noop' };
      },
      async onTurnComplete() {
        return { trimToolResults: ['toolu_not_in_input'] };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('not a tool_use id in the input');
  });

  it('fails an engine whose nominations are non-deterministic', async () => {
    let n = 0;
    const result = await validateContextEngine({
      name: 'flappy',
      async compact(opts) {
        return { messages: opts.messages, notes: 'noop' };
      },
      async onTurnComplete() {
        return n++ === 0 ? {} : { notes: 'different' };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('not deterministic');
  });
});
