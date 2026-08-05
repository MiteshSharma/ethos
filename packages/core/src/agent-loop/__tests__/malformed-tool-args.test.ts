import type { AgentEvent, CompletionChunk, LLMProvider, Tool, ToolResult } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../__tests__/helpers/test-safety';
import { AgentLoop } from '../../agent-loop';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../../tool-registry';

// LLM that emits a single tool call with a caller-supplied (possibly malformed)
// inputJson on turn 1, then ends the turn on turn 2.
function makeToolThenDoneLLM(toolName: string, inputJson: string): LLMProvider {
  let call = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      call++;
      if (call === 1) {
        yield { type: 'tool_use_start', toolCallId: 'tc1', toolName };
        yield { type: 'tool_use_delta', toolCallId: 'tc1', partialJson: inputJson };
        yield { type: 'tool_use_end', toolCallId: 'tc1', inputJson };
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

function makeSpyTool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: { type: 'object' },
    capabilities: {},
    execute,
  };
}

function makeSpyToolWithRequired(name: string, required: string[], execute: Tool['execute']): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: { type: 'object', properties: {}, required },
    capabilities: {},
    execute,
  };
}

// Lane 4a — tool with typed top-level properties for the coercion tests.
function makeTypedTool(
  name: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: Tool['execute'],
): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: { type: 'object', properties, required },
    capabilities: {},
    execute,
  };
}

function makeFakeObservability(): AgentLoopObservability & {
  repairs: Array<{ toolName: string; outcome: 'repaired' | 'failed' }>;
} {
  const repairs: Array<{ toolName: string; outcome: 'repaired' | 'failed' }> = [];
  return {
    repairs,
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: () => 'span-1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordToolRepair: (opts) => repairs.push({ toolName: opts.toolName, outcome: opts.outcome }),
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('malformed tool arguments (§4 silent-{} bugfix)', () => {
  it('never executes a tool with {} when args are unparseable and unrepairable', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'ran' }));
    const tools = new DefaultToolRegistry();
    tools.register(makeSpyTool('do_thing', execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      llm: makeToolThenDoneLLM('do_thing', 'totally not json'),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    const events = await collect(loop.run('go'));

    // Invariant: the tool was NEVER executed.
    expect(execute).not.toHaveBeenCalled();

    // A visible is_error tool_end was produced for the malformed call.
    const toolEnd = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'do_thing',
    );
    expect(toolEnd).toBeDefined();
    expect(toolEnd?.ok).toBe(false);
    expect(toolEnd?.error).toContain('malformed tool arguments');

    // A repair-failed observability event was recorded.
    expect(obs.repairs).toEqual([{ toolName: 'do_thing', outcome: 'failed' }]);
  });

  it('executes the tool with REPAIRED args when the malformed JSON is repairable', async () => {
    let seenArgs: unknown;
    const execute = vi.fn(async (args: unknown): Promise<ToolResult> => {
      seenArgs = args;
      return { ok: true, value: 'ran' };
    });
    const tools = new DefaultToolRegistry();
    tools.register(makeSpyTool('do_thing', execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      llm: makeToolThenDoneLLM('do_thing', "{'path': '/tmp/x', force: true,}"),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    await collect(loop.run('go'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs).toEqual({ path: '/tmp/x', force: true });
    expect(obs.repairs).toEqual([{ toolName: 'do_thing', outcome: 'repaired' }]);
  });

  it('rejects a REPAIRED call missing a required field instead of executing it', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'ran' }));
    const tools = new DefaultToolRegistry();
    tools.register(makeSpyToolWithRequired('write_file', ['path', 'content'], execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      // Repairs to { path: '/tmp/x' } — valid object but missing `content`.
      llm: makeToolThenDoneLLM('write_file', "{'path': '/tmp/x',}"),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    const events = await collect(loop.run('go'));

    // Incomplete repair must NOT execute the tool.
    expect(execute).not.toHaveBeenCalled();

    // A visible is_error tool_end naming the missing field is produced.
    const toolEnd = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'write_file',
    );
    expect(toolEnd?.ok).toBe(false);
    expect(toolEnd?.error).toContain('missing required field(s): content');

    // The args were still repaired (the observability event fires on repair).
    expect(obs.repairs).toEqual([{ toolName: 'write_file', outcome: 'repaired' }]);
  });

  it('executes a REPAIRED call that has every required field', async () => {
    let seenArgs: unknown;
    const execute = vi.fn(async (args: unknown): Promise<ToolResult> => {
      seenArgs = args;
      return { ok: true, value: 'ran' };
    });
    const tools = new DefaultToolRegistry();
    tools.register(makeSpyToolWithRequired('write_file', ['path', 'content'], execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      llm: makeToolThenDoneLLM('write_file', "{'path': '/tmp/x', content: 'hi',}"),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    await collect(loop.run('go'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs).toEqual({ path: '/tmp/x', content: 'hi' });
  });

  it('does NOT validate CLEAN strict-parse args missing a required field (repaired-path only)', async () => {
    let seenArgs: unknown;
    const execute = vi.fn(async (args: unknown): Promise<ToolResult> => {
      seenArgs = args;
      return { ok: true, value: 'ran' };
    });
    const tools = new DefaultToolRegistry();
    tools.register(makeSpyToolWithRequired('write_file', ['path', 'content'], execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      // Valid JSON — parses cleanly, no repair — even though `content` is absent.
      llm: makeToolThenDoneLLM('write_file', '{"path": "/tmp/x"}'),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    await collect(loop.run('go'));

    // Clean parse is trusted: the tool executes as today, no required-field gate.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs).toEqual({ path: '/tmp/x' });
    expect(obs.repairs).toEqual([]);
  });

  it('runs a REPAIRED call with no required fields regardless of contents', async () => {
    let seenArgs: unknown;
    const execute = vi.fn(async (args: unknown): Promise<ToolResult> => {
      seenArgs = args;
      return { ok: true, value: 'ran' };
    });
    const tools = new DefaultToolRegistry();
    // No `required` on the schema.
    tools.register(makeSpyTool('do_thing', execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      llm: makeToolThenDoneLLM('do_thing', "{'a': 1,}"),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    await collect(loop.run('go'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs).toEqual({ a: 1 });
    expect(obs.repairs).toEqual([{ toolName: 'do_thing', outcome: 'repaired' }]);
  });

  it('names the missing field WITH its expected type when the schema declares one (Lane 4a stage-3 delta)', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'ran' }));
    const tools = new DefaultToolRegistry();
    tools.register(
      makeTypedTool(
        'write_file',
        { path: { type: 'string' }, content: { type: 'string' } },
        ['path', 'content'],
        execute,
      ),
    );

    const loop = new AgentLoop({
      // Repairs to { path: '/tmp/x' } — missing required `content`.
      llm: makeToolThenDoneLLM('write_file', "{'path': '/tmp/x',}"),
      tools,
      safety: createTestSafety(),
    });
    const events = await collect(loop.run('go'));

    expect(execute).not.toHaveBeenCalled();
    const toolEnd = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'write_file',
    );
    expect(toolEnd?.error).toContain('missing required field(s): content (expected string)');
  });

  it('runs a zero-argument tool with {} when the argument stream is empty', async () => {
    let seenArgs: unknown = 'unset';
    const execute = vi.fn(async (args: unknown): Promise<ToolResult> => {
      seenArgs = args;
      return { ok: true, value: 'ran' };
    });
    const tools = new DefaultToolRegistry();
    tools.register(makeSpyTool('noarg', execute));
    const obs = makeFakeObservability();

    const loop = new AgentLoop({
      llm: makeToolThenDoneLLM('noarg', ''),
      tools,
      safety: createTestSafety(),
      observability: obs,
    });
    await collect(loop.run('go'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs).toEqual({});
    // Empty stream is legitimate, not a repair.
    expect(obs.repairs).toEqual([]);
  });
});

describe('repaired-args type coercion (Lane 4a stage-2 delta)', () => {
  async function runRepairedCall(
    inputJson: string,
    properties: Record<string, unknown>,
    required: string[],
  ) {
    let seenArgs: unknown;
    const execute = vi.fn(async (args: unknown): Promise<ToolResult> => {
      seenArgs = args;
      return { ok: true, value: 'ran' };
    });
    const tools = new DefaultToolRegistry();
    tools.register(makeTypedTool('typed_tool', properties, required, execute));
    const loop = new AgentLoop({
      llm: makeToolThenDoneLLM('typed_tool', inputJson),
      tools,
      safety: createTestSafety(),
    });
    const events = await collect(loop.run('go'));
    return { execute, seenArgs: () => seenArgs, events };
  }

  function toolEndOf(events: AgentEvent[]) {
    return events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'typed_tool',
    );
  }

  it('coerces string "5" to a number field', async () => {
    // Unquoted key + single quotes force the repair path.
    const { execute, seenArgs } = await runRepairedCall(
      "{count: '5'}",
      { count: { type: 'number' } },
      ['count'],
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs()).toEqual({ count: 5 });
  });

  it('coerces string "true" to a boolean field', async () => {
    const { execute, seenArgs } = await runRepairedCall(
      "{enabled: 'true'}",
      { enabled: { type: 'boolean' } },
      ['enabled'],
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs()).toEqual({ enabled: true });
  });

  it('wraps a single value into an array-of field', async () => {
    const { execute, seenArgs } = await runRepairedCall(
      "{paths: '/tmp/x',}",
      { paths: { type: 'array', items: { type: 'string' } } },
      ['paths'],
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs()).toEqual({ paths: ['/tmp/x'] });
  });

  it('rejects a NON-coercible mismatch with a per-field message naming field, expected, and got', async () => {
    const { execute, events } = await runRepairedCall(
      "{count: 'lots'}",
      { count: { type: 'number' } },
      ['count'],
    );
    expect(execute).not.toHaveBeenCalled();
    const toolEnd = toolEndOf(events);
    expect(toolEnd?.ok).toBe(false);
    expect(toolEnd?.error).toContain('wrong-typed field(s): count (expected number, got string)');
  });

  it('a wrong-typed OPTIONAL field does not reject the call (behavior-preserving scope)', async () => {
    const { execute, seenArgs } = await runRepairedCall(
      "{path: '/tmp/x', mode: 7}",
      { path: { type: 'string' }, mode: { type: 'string' } },
      ['path'],
    );
    // `mode` mismatches (number for string) but is optional — the tool still
    // runs, exactly as it did before the Lane 4a delta.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seenArgs()).toEqual({ path: '/tmp/x', mode: 7 });
  });
});
