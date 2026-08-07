// tools-as-code-api Lanes B + D — the ScriptToolBridge enforces the SAME
// contract as the LLM tool path: identical out-of-toolset error text, one
// shared `before_tool_call` fire site, one set of turn budget counters, a
// watcher that can kill a whole execution, and the Lane D budget asymmetry
// (script results untrimmed, LLM results turn-trimmed).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { checkTurnBudgets } from '../agent-loop/budgets';
import {
  createTurnBudgetCounters,
  type TurnBudgetCounters,
} from '../agent-loop/stages/per-call-enforcement';
import {
  SCRIPT_CALLS_PER_EXECUTION,
  ScriptToolBridge,
} from '../agent-loop/stages/script-tool-bridge';
import type { WatcherTap } from '../agent-loop/turn-context';
import { makeTestToolContext } from '../defaults/in-memory-tool-context';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stubTool(name: string, opts?: Partial<Tool>): Tool {
  return {
    name,
    description: `${name} fixture`,
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: `${name}:ran` }),
    ...opts,
  };
}

/** Registry with a run_code stub (the script surface is gated on it) + fixtures. */
function makeRegistry(extra: Tool[] = []): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register(stubTool('run_code', { toolset: 'code' }));
  tools.register(stubTool('worker'));
  tools.register(stubTool('write_file', { toolset: 'file' }));
  tools.register(stubTool('outside_tool'));
  for (const t of extra) tools.register(t);
  return tools;
}

const NO_HALT_TAP: WatcherTap = { observe: () => {}, getHalt: () => null };

interface BridgeSetup {
  api: ReturnType<ScriptToolBridge['bind']>;
  counters: TurnBudgetCounters;
  ctx: ToolContext;
}

function makeBridge(opts: {
  tools: DefaultToolRegistry;
  allowedTools?: string[];
  hooks?: DefaultHookRegistry;
  maxToolCallsPerTurn?: number;
  watcherTap?: WatcherTap;
}): BridgeSetup {
  const counters = createTurnBudgetCounters();
  const bridge = new ScriptToolBridge({
    tools: opts.tools,
    hooks: opts.hooks ?? new DefaultHookRegistry(),
    sessionId: 'bridge-session',
    traceId: undefined,
    allowedTools: opts.allowedTools,
    allowedPlugins: [],
    filterOpts: {},
    watcherTap: opts.watcherTap ?? NO_HALT_TAP,
    counters,
    checkBudgets: () =>
      checkTurnBudgets(
        counters.totalToolCalls,
        opts.maxToolCallsPerTurn ?? 1000,
        counters.toolNameCounts,
        1000,
        counters.identicalStreak,
        1000,
      ),
  });
  const ctx = makeTestToolContext();
  const api = bridge.bind(() => ctx);
  return { api, counters, ctx };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/** Scripted LLM: one tool_use of `toolName`, then a plain text end_turn. */
function makeOneToolLLM(toolName: string, args: unknown = {}): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls > 1) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const inputJson = JSON.stringify(args);
      yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
      yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Lane B — same contract, second enforcement point
// ---------------------------------------------------------------------------

describe('ScriptToolBridge — script-callable surface', () => {
  it('an out-of-toolset call returns the EXACT registry error text of the LLM path', async () => {
    const tools = makeRegistry();
    const allowedTools = ['run_code', 'worker'];
    const { api } = makeBridge({ tools, allowedTools });

    // The LLM path: executeParallel with the personality allowlist.
    const [direct] = await tools.executeParallel(
      [{ toolCallId: 'd1', name: 'outside_tool', args: {} }],
      makeTestToolContext(),
      allowedTools,
    );
    expect(direct?.result.ok).toBe(false);

    const scripted = await api.startExecution().call('outside_tool', {});
    expect(scripted.ok).toBe(false);
    if (direct && !direct.result.ok) {
      expect(scripted.error).toBe(direct.result.error);
      expect(scripted.error).toBe('Tool outside_tool is not permitted for this personality');
      expect(scripted.code).toBe(direct.result.code);
    }
  });

  it('an unknown tool returns the registry "Unknown tool" error', async () => {
    const { api } = makeBridge({ tools: makeRegistry(), allowedTools: ['run_code', 'worker'] });
    const res = await api.startExecution().call('no_such_tool', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Unknown tool: no_such_tool');
  });

  it('excluded categories fail with the exclusion error naming the category', async () => {
    const tools = makeRegistry([
      stubTool('delegate_task', { toolset: 'delegation' }),
      stubTool('clarify'),
    ]);
    tools.register(stubTool('plug_tool'), { pluginId: 'some-plugin' });
    const { api } = makeBridge({
      tools,
      allowedTools: ['run_code', 'worker', 'delegate_task', 'clarify', 'plug_tool'],
    });
    const exec = api.startExecution();

    const recurse = await exec.call('run_code', {});
    expect(recurse.ok).toBe(false);
    expect(recurse.error).toContain('excluded category: code');

    const delegation = await exec.call('delegate_task', {});
    expect(delegation.error).toContain('excluded category: delegation');

    const clarify = await exec.call('clarify', {});
    expect(clarify.error).toContain('excluded category: clarify');

    const mcp = await exec.call('mcp__linear__list_issues', {});
    expect(mcp.error).toContain('excluded category: mcp');

    const plugin = await exec.call('plug_tool', {});
    expect(plugin.error).toContain('excluded category: plugin');
  });

  it('callableTools() lists the personality-permitted, script-safe surface', () => {
    const { api } = makeBridge({
      tools: makeRegistry(),
      allowedTools: ['run_code', 'worker', 'write_file'],
    });
    expect(api.callableTools()).toEqual(['worker', 'write_file']);
  });

  it('a permitted call executes through the registry and returns the value', async () => {
    const { api, counters } = makeBridge({
      tools: makeRegistry(),
      allowedTools: ['run_code', 'worker'],
    });
    const res = await api.startExecution().call('worker', { x: 1 });
    expect(res).toEqual({ ok: true, value: 'worker:ran' });
    expect(counters.totalToolCalls).toBe(1);
    expect(counters.toolNameCounts.get('worker')).toBe(1);
  });
});

describe('ScriptToolBridge — shared before_tool_call fire site', () => {
  it('one hook fixture blocks write_file identically on the LLM path and the script path', async () => {
    const tools = makeRegistry();
    const hooks = new DefaultHookRegistry();
    const BLOCK = 'write_file blocked by policy fixture';
    hooks.registerModifying('before_tool_call', async (payload) =>
      payload.toolName === 'write_file' ? { error: BLOCK } : {},
    );

    // Script path.
    const { api } = makeBridge({
      tools,
      hooks,
      allowedTools: ['run_code', 'worker', 'write_file'],
    });
    const scripted = await api.startExecution().call('write_file', { path: '/tmp/x' });
    expect(scripted.ok).toBe(false);
    expect(scripted.error).toBe(BLOCK);

    // LLM path — the same hook registry instance wired into a real loop.
    const loop = new AgentLoop({
      llm: makeOneToolLLM('write_file', { path: '/tmp/x' }),
      tools,
      hooks,
      safety: createTestSafety(),
    });
    const events = await collect(loop.run('go', { sessionKey: 'hook-parity' }));
    const end = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'write_file',
    );
    expect(end?.ok).toBe(false);
    expect(end?.error).toBe(BLOCK);
  });
});

describe('ScriptToolBridge — watcher halts', () => {
  it('a terminate mid-script fails the call AND aborts the execution with the reason', async () => {
    let starts = 0;
    const tap: WatcherTap = {
      observe: (event) => {
        if (event.type === 'tool_start') starts++;
      },
      getHalt: () =>
        starts >= 2
          ? { action: 'terminate', rule: 'too-many-calls', reason: 'script ran hot' }
          : null,
    };
    const { api } = makeBridge({
      tools: makeRegistry(),
      allowedTools: ['run_code', 'worker'],
      watcherTap: tap,
    });
    const aborts: string[] = [];
    const exec = api.startExecution({ onAbortExecution: (reason) => aborts.push(reason) });

    const first = await exec.call('worker', { i: 1 });
    expect(first.ok).toBe(true);

    const second = await exec.call('worker', { i: 2 });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('Watcher halted before execution: script ran hot');
    expect(second.code).toBe('watcher_halt');
    expect(aborts).toEqual(['Watcher halted before execution: script ran hot']);

    // Subsequent calls fail fast — the execution is dead.
    const third = await exec.call('worker', { i: 3 });
    expect(third.ok).toBe(false);
    expect(third.code).toBe('execution_aborted');
  });
});

// ---------------------------------------------------------------------------
// Lane D — budgets
// ---------------------------------------------------------------------------

describe('ScriptToolBridge — Lane D budgets', () => {
  it(`call ${SCRIPT_CALLS_PER_EXECUTION + 1} fails with the named per-execution-cap error`, async () => {
    const { api, counters } = makeBridge({
      tools: makeRegistry(),
      allowedTools: ['run_code', 'worker'],
    });
    const exec = api.startExecution();
    for (let i = 1; i <= SCRIPT_CALLS_PER_EXECUTION; i++) {
      const res = await exec.call('worker', { i });
      expect(res.ok).toBe(true);
    }
    const over = await exec.call('worker', { i: 51 });
    expect(over.ok).toBe(false);
    expect(over.code).toBe('per_execution_cap');
    expect(over.error).toContain(`${SCRIPT_CALLS_PER_EXECUTION} tool calls per script execution`);
    // The capped call never reached the shared counters.
    expect(counters.totalToolCalls).toBe(SCRIPT_CALLS_PER_EXECUTION);

    // A NEW execution in the same turn gets a fresh per-execution budget.
    const fresh = await api.startExecution().call('worker', { i: 52 });
    expect(fresh.ok).toBe(true);
  });

  it('budget asymmetry: a 200KB result reaches the script untrimmed but is turn-trimmed on the LLM path', async () => {
    const FAT = 'x'.repeat(200_000);
    const tools = makeRegistry([
      stubTool('fat_tool', { execute: async () => ({ ok: true, value: FAT }) }),
    ]);
    const allowedTools = ['run_code', 'fat_tool'];

    // LLM path: the turn budget (80k default) splits and post-trims.
    const [direct] = await tools.executeParallel(
      [{ toolCallId: 'd1', name: 'fat_tool', args: {} }],
      makeTestToolContext(),
      allowedTools,
    );
    expect(direct?.result.ok).toBe(true);
    if (direct?.result.ok) {
      expect(direct.result.value.length).toBeLessThan(FAT.length);
      expect(direct.result.value).toContain('[truncated — 200000 chars total]');
    }

    // Script path: script-scoped budget (262_144) — untrimmed.
    const { api } = makeBridge({ tools, allowedTools });
    const scripted = await api.startExecution().call('fat_tool', {});
    expect(scripted.ok).toBe(true);
    expect(scripted.value).toBe(FAT);
  });

  it('a tool-declared maxResultChars still caps the script-delivered result', async () => {
    const tools = makeRegistry([
      stubTool('capped_tool', {
        maxResultChars: 1_000,
        execute: async () => ({ ok: true, value: 'y'.repeat(5_000) }),
      }),
    ]);
    const { api } = makeBridge({ tools, allowedTools: ['run_code', 'capped_tool'] });
    const res = await api.startExecution().call('capped_tool', {});
    expect(res.ok).toBe(true);
    expect(res.value).toContain('[truncated — 5000 chars total]');
    expect(res.value?.length).toBeLessThan(1_100);
  });
});

// ---------------------------------------------------------------------------
// Shared turn budget — through a real AgentLoop turn
// ---------------------------------------------------------------------------

describe('ScriptToolBridge — shared turn budget through AgentLoop', () => {
  it('60 script calls with maxToolCallsPerTurn 50 trip the turn-budget halt (kind: budget)', async () => {
    const tools = new DefaultToolRegistry();
    // The script surface is gated on run_code being reachable (Lane C).
    tools.register(stubTool('run_code', { toolset: 'code' }));
    tools.register(stubTool('worker'));
    const scriptResults: Array<{ ok: boolean; error?: string }> = [];
    // A stand-in for run_code: drives 60 in-script calls through the seam.
    tools.register(
      stubTool('scripty', {
        execute: async (_args, ctx) => {
          const api = ctx.scriptTools;
          if (!api) return { ok: false, error: 'no bridge', code: 'not_available' };
          const exec = api.startExecution();
          for (let i = 1; i <= 60; i++) {
            scriptResults.push(await exec.call('worker', { i }));
          }
          return { ok: true, value: `made ${scriptResults.length} calls` };
        },
      }),
    );

    const loop = new AgentLoop({
      llm: makeOneToolLLM('scripty'),
      tools,
      safety: createTestSafety(),
      options: { maxToolCallsPerTurn: 50, maxIdenticalToolCalls: 1000 },
    });
    const events = await collect(loop.run('go', { sessionKey: 'script-budget' }));

    // The bridge failed the over-cap calls with the loop's own budget message…
    const failed = scriptResults.filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.error).toBe('Stopped: hit 50-tool-call budget for this turn');
    // …and the loop's boundary check then halted the turn (counters are SHARED).
    const halt = events.find((e): e is Extract<AgentEvent, { type: 'halt' }> => e.type === 'halt');
    expect(halt?.kind).toBe('budget');
    expect(halt?.rule).toBe('tool-budget');
  });

  it('a tool using ctx.scriptTools completes a single turn (threading + no deadlock)', async () => {
    const tools = new DefaultToolRegistry();
    tools.register(stubTool('run_code', { toolset: 'code' }));
    tools.register(stubTool('worker'));
    tools.register(
      stubTool('scripty', {
        execute: async (_args, ctx) => {
          const api = ctx.scriptTools;
          if (!api) return { ok: false, error: 'no bridge', code: 'not_available' };
          const res = await api.startExecution().call('worker', {});
          return { ok: true, value: `worker said: ${res.value}` };
        },
      }),
    );
    const loop = new AgentLoop({
      llm: makeOneToolLLM('scripty'),
      tools,
      safety: createTestSafety(),
    });
    const events = await collect(loop.run('go', { sessionKey: 'script-thread' }));
    const end = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> =>
        e.type === 'tool_end' && e.toolName === 'scripty',
    );
    expect(end?.ok).toBe(true);
    expect(end?.result).toBe('worker said: worker:ran');
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Grep-level guard — exactly ONE production before_tool_call fire site
// ---------------------------------------------------------------------------

describe('before_tool_call fire-site guard', () => {
  it('production core has exactly one fireModifying("before_tool_call") site (per-call-enforcement.ts)', () => {
    const srcRoot = join(import.meta.dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf-8');
        const fireSite = /fireModifying\(\s*'before_tool_call'/g;
        if (fireSite.test(text)) hits.push(full);
      }
    };
    walk(srcRoot);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('per-call-enforcement.ts');
  });
});
