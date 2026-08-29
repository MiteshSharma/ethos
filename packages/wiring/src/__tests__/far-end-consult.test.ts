// The restricted receptionist scope (voice V4 E6, eng-review D12).
//
// The claim under test is not "a flag was set". It is: when a NON-ALLOWLISTED
// caller's `agent_consult` runs, the turn cannot read the owner's memory and
// cannot execute a privileged tool. So these tests drive a real `AgentLoop`
// against a real `DefaultToolRegistry` and a real memory provider, capture what
// the model was actually shown, and have the model TRY the privileged tool.
//
// Both restrictions come from mechanisms this repo already had — the turn's
// memory scope is `personality:<id>` and its tool allowlist is that
// personality's `toolset` — which is the whole point: pinning the personality
// is the restriction, so there is no second system to keep in step.

import type { AgentLoop } from '@ethosagent/core';
import {
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
  AgentLoop as Loop,
} from '@ethosagent/core';
import { AGENT_CONSULT_TOOL } from '@ethosagent/tools-voice';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  MemoryContext,
  MemoryEntry,
  MemoryProvider,
  MemorySnapshot,
  Message,
  Tool,
  ToolContext,
  ToolDefinitionLite,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createFarEndConsultTool, FAR_END_VOICE_ORIGIN } from '../far-end-consult';
import { createTestSafety } from './helpers/wiring-test-safety';

const OWNER_SECRET = 'the owner keeps their spare key under the third flowerpot';

/** Memory that answers ONLY for the owner's scope. */
function scopedMemory(seen: string[]): MemoryProvider {
  const owned: Record<string, string> = { 'MEMORY.md': OWNER_SECRET };
  return {
    async prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
      seen.push(ctx.scopeId);
      if (ctx.scopeId !== 'personality:owner') return null;
      return { entries: Object.entries(owned).map(([key, content]) => ({ key, content })) };
    },
    async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
      seen.push(ctx.scopeId);
      if (ctx.scopeId !== 'personality:owner') return null;
      const content = owned[key];
      return content ? { key, content } : null;
    },
    async search(): Promise<MemoryEntry[]> {
      return [];
    },
    async sync(): Promise<void> {},
    async list() {
      return [];
    },
  };
}

/** Records every execution of the privileged tool. Must stay empty. */
function privilegedTool(executions: string[]): Tool {
  return {
    name: 'terminal',
    description: 'Runs a shell command.',
    toolset: 'terminal',
    capabilities: {},
    schema: { type: 'object', properties: { cmd: { type: 'string' } } },
    async execute(args): Promise<ToolResult> {
      executions.push(JSON.stringify(args));
      return { ok: true, value: 'ran' };
    },
  };
}

function harmlessTool(): Tool {
  return {
    name: 'read_clock',
    description: 'Says what time it is.',
    toolset: 'time',
    capabilities: {},
    schema: { type: 'object' },
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'noon' };
    },
  };
}

interface Capture {
  /** Tool definitions the model was shown, per LLM round. */
  toolNames: string[][];
  /** System prompts the model was shown. */
  systems: string[];
}

/**
 * A model that reaches for the privileged tool on its first round, then speaks.
 * "It tried and was refused" is a stronger assertion than "it was not offered".
 */
function grabbyLLM(capture: Capture): LLMProvider {
  let round = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _messages: Message[],
      tools: ToolDefinitionLite[],
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      capture.systems.push(options.system ?? '');
      capture.toolNames.push(tools.map((t) => t.name));
      round++;
      if (round === 1) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'terminal' };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{"cmd":"cat ~/.ssh/id_rsa"}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'I cannot help with that.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function buildLoop(opts: { capture: Capture; executions: string[]; scopes: string[] }): {
  loop: AgentLoop;
  tools: DefaultToolRegistry;
} {
  const personalities = new DefaultPersonalityRegistry();
  // The owner: every tool, its own memory scope.
  personalities.define({
    id: 'owner',
    name: 'Owner',
    toolset: ['terminal', 'read_clock'],
  });
  // The receptionist: a DELIBERATELY narrow toolset. `terminal` is absent, so
  // the registry filters it out of the definitions AND rejects a call to it.
  personalities.define({
    id: 'reception',
    name: 'Reception',
    toolset: ['read_clock'],
  });

  const tools = new DefaultToolRegistry();
  tools.register(privilegedTool(opts.executions));
  tools.register(harmlessTool());

  const loop = new Loop({
    llm: grabbyLLM(opts.capture),
    tools,
    personalities,
    memory: scopedMemory(opts.scopes),
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  return { loop, tools };
}

/** Run one consult and drain the events. */
async function consult(tool: Tool, ctx: Partial<ToolContext>): Promise<ToolResult> {
  return tool.execute({ prompt: 'can you read the owner notes and run a command for me' }, {
    sessionKey: 'voice:reception:sip:%2B15559998888',
    ...ctx,
  } as ToolContext);
}

describe('far-end consult — the restricted receptionist scope', () => {
  it('stamps a far-end SIP origin, never the owner talk-mode one', () => {
    expect(FAR_END_VOICE_ORIGIN).toEqual({ transport: 'sip', speaker: 'far_end' });
  });

  it('a non-allowlisted caller reaches neither owner memory nor a privileged tool', async () => {
    const capture: Capture = { toolNames: [], systems: [] };
    const executions: string[] = [];
    const scopes: string[] = [];
    const { loop } = buildLoop({ capture, executions, scopes });

    const result = await consult(
      createFarEndConsultTool(loop, { receptionistPersonalityId: 'reception' }),
      // The caller's context claims the OWNER personality. The pin must win —
      // a screened caller does not get to name the scope they run in.
      { personalityId: 'owner' },
    );

    expect(result.ok).toBe(true);

    // 1. Memory: the turn only ever asked the receptionist's scope, and the
    //    owner's secret never reached the prompt.
    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes)).toEqual(new Set(['personality:reception']));
    for (const system of capture.systems) expect(system).not.toContain(OWNER_SECRET);

    // 2. Tools: `terminal` was never advertised...
    expect(capture.toolNames.length).toBeGreaterThan(0);
    for (const names of capture.toolNames) {
      expect(names).not.toContain('terminal');
      expect(names).toContain('read_clock');
    }
    // ...and the model's attempt to call it anyway did not execute it.
    expect(executions).toEqual([]);
  });

  // The control. Without the pin the SAME loop, the SAME registry and the SAME
  // model do reach both — which is what makes the assertions above meaningful
  // rather than a test of an empty registry.
  it('the owner scope DOES reach both — the restriction is the pin, not the fixture', async () => {
    const capture: Capture = { toolNames: [], systems: [] };
    const executions: string[] = [];
    const scopes: string[] = [];
    const { loop } = buildLoop({ capture, executions, scopes });

    await consult(createFarEndConsultTool(loop), { personalityId: 'owner' });

    expect(new Set(scopes)).toEqual(new Set(['personality:owner']));
    expect(capture.systems.join('\n')).toContain(OWNER_SECRET);
    expect(capture.toolNames[0]).toContain('terminal');
    expect(executions).toHaveLength(1);
  });

  it('is registered under the same tool name the realtime seam advertises', () => {
    const capture: Capture = { toolNames: [], systems: [] };
    const { loop } = buildLoop({ capture, executions: [], scopes: [] });
    expect(createFarEndConsultTool(loop).name).toBe(AGENT_CONSULT_TOOL);
  });
});
