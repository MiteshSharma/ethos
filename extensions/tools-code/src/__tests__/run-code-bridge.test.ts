// tools-as-code-api Lanes B + D — run_code's side of the ScriptToolBridge:
// framed mode engages only when ctx.scriptTools is present, RPC requests are
// answered through the bridge while the exec stream is being pumped (deadlock
// shape), a watcher halt kills the execution via the exec abort signal, the
// tool-API wall clock is clamped to 300s, and the run_code result entering
// history stays under its 10k cap regardless of script activity.

import {
  checkTurnBudgets,
  createTurnBudgetCounters,
  DefaultHookRegistry,
  DefaultToolRegistry,
  makeTestToolContext,
  SCRIPT_CALLS_PER_EXECUTION,
  ScriptToolBridge,
} from '@ethosagent/core';
import type {
  AgentEvent,
  ExecChunk,
  ExecOpts,
  ExecRpcResponse,
  ExecutionBackend,
  Tool,
  ToolContext,
  ToolProgressEvent,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createCodeTools } from '../index';

// ---------------------------------------------------------------------------
// Fake RPC-aware execution backend
// ---------------------------------------------------------------------------

interface FakeBackend extends ExecutionBackend {
  lastCmd?: string;
  lastOpts?: ExecOpts;
}

/**
 * Backend whose exec "script" drives `opts.rpc.onRequest` like the shim would:
 * `script(call)` decides what the fake script does; its yielded chunks are the
 * script's stdout. Honors `opts.signal` between calls (abort kills the run).
 */
function makeRpcBackend(
  script: (
    call: (name: string, args: unknown) => Promise<ExecRpcResponse>,
    opts: ExecOpts,
  ) => AsyncIterable<ExecChunk>,
): FakeBackend {
  const backend: FakeBackend = {
    name: 'docker',
    isAvailable: async () => true,
    exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
      backend.lastCmd = cmd;
      backend.lastOpts = opts;
      const call = async (name: string, args: unknown): Promise<ExecRpcResponse> => {
        if (opts.signal?.aborted) throw new Error('Aborted');
        const rpc = opts.rpc;
        if (!rpc) throw new Error('no rpc seam on opts');
        const res = await rpc.onRequest({ name, args });
        if (opts.signal?.aborted) throw new Error('Aborted');
        return res;
      };
      return script(call, opts);
    },
    spawnSession(personalityId: string) {
      return {
        personalityId,
        exec: (cmd: string, opts: ExecOpts = {}) => backend.exec(cmd, opts),
        dispose: () => Promise.resolve(),
      };
    },
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return backend;
}

// ---------------------------------------------------------------------------
// Bridge + registry harness
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

type HaltFn = () => {
  action: 'pause' | 'force_approval' | 'terminate';
  rule: string;
  reason: string;
} | null;

function makeHarness(
  backend: ExecutionBackend,
  opts?: { getHalt?: HaltFn; extraTools?: Tool[]; allowedTools?: string[] },
) {
  // Empty capability backends: run_code declares a process capability, and the
  // registry fails closed on capability-declaring tools without a backends bag.
  const tools = new DefaultToolRegistry({});
  for (const t of createCodeTools({ backend })) tools.register(t);
  tools.register(stubTool('worker'));
  for (const t of opts?.extraTools ?? []) tools.register(t);
  const counters = createTurnBudgetCounters();
  const bridge = new ScriptToolBridge({
    tools,
    hooks: new DefaultHookRegistry(),
    sessionId: 's1',
    traceId: undefined,
    allowedTools: opts?.allowedTools ?? ['run_code', 'worker'],
    allowedPlugins: [],
    filterOpts: {},
    watcherTap: { observe: () => {}, getHalt: opts?.getHalt ?? (() => null) },
    counters,
    checkBudgets: () =>
      checkTurnBudgets(
        counters.totalToolCalls,
        1000,
        counters.toolNameCounts,
        1000,
        counters.identicalStreak,
        1000,
      ),
  });
  // Lane E capture: the inner-call AgentEvents the bridge emits and the
  // progress events run_code itself emits via ctx.emit.
  const events: AgentEvent[] = [];
  const progress: ToolProgressEvent[] = [];
  const base = makeTestToolContext();
  const ctx: ToolContext = {
    ...base,
    toolCallId: 'parent-1',
    emit: (e) => progress.push(e),
    scriptTools: bridge.bind(
      () => ctx,
      (e) => events.push(e),
    ),
  };
  return { tools, ctx, counters, events, progress };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run_code × ScriptToolBridge', () => {
  it('answers in-script tool calls through the bridge while pumping the exec stream (deadlock shape)', async () => {
    const backend = makeRpcBackend(async function* (call) {
      const res = await call('worker', { n: 1 });
      yield { stream: 'stdout', data: `got:${res.ok}:${res.value}\n` };
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend);
    const runCode = tools.get('run_code');
    const result = await runCode?.execute({ runtime: 'python', code: 'x' }, ctx);
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBe('got:true:worker:ran');
    // Framed mode: shim command, RPC seam, abort signal, capped wall clock.
    expect(backend.lastCmd).toContain('python3 -c');
    expect(backend.lastCmd).not.toBe('python3 -');
    expect(backend.lastOpts?.rpc).toBeDefined();
    expect(backend.lastOpts?.signal).toBeDefined();
  });

  it('runs UNFRAMED with no rpc seam when ctx.scriptTools is absent (no-bridge case, no hang)', async () => {
    const backend = makeRpcBackend(async function* (_call, opts) {
      // A plain script — the fake never touches rpc here.
      void opts;
      yield { stream: 'stdout', data: 'plain\n' };
      yield { stream: 'exit', code: 0 };
    });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute(
      { runtime: 'python', code: 'print(1)' },
      makeTestToolContext(),
    );
    expect(result.ok).toBe(true);
    expect(backend.lastCmd).toBe('python3 -');
    expect(backend.lastOpts?.rpc).toBeUndefined();
    expect(backend.lastOpts?.signal).toBeUndefined();
  });

  it('bash stays unframed even when the bridge is wired (no bash shim at v1)', async () => {
    const backend = makeRpcBackend(async function* () {
      yield { stream: 'stdout', data: 'sh\n' };
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend);
    const result = await tools.get('run_code')?.execute({ runtime: 'bash', code: 'echo sh' }, ctx);
    expect(result?.ok).toBe(true);
    expect(backend.lastCmd).toBe('bash -s');
    expect(backend.lastOpts?.rpc).toBeUndefined();
  });

  it('clamps timeout_ms to 300s for tool-API executions; plain executions keep the raw value', async () => {
    const backend = makeRpcBackend(async function* () {
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend);
    await tools
      .get('run_code')
      ?.execute({ runtime: 'python', code: 'x', timeout_ms: 900_000 }, ctx);
    expect(backend.lastOpts?.timeoutMs).toBe(300_000);

    await tools
      .get('run_code')
      ?.execute({ runtime: 'python', code: 'x', timeout_ms: 900_000 }, makeTestToolContext());
    expect(backend.lastOpts?.timeoutMs).toBe(900_000);

    // The default stays 30s on both paths.
    await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    expect(backend.lastOpts?.timeoutMs).toBe(30_000);
  });

  it('a watcher halt mid-script aborts the execution and run_code fails with the watcher reason', async () => {
    let calls = 0;
    const backend = makeRpcBackend(async function* (call) {
      // The fake script loops tool calls until the abort kills it.
      for (let i = 0; i < 10; i++) {
        await call('worker', { i });
      }
      yield { stream: 'stdout', data: 'unreachable\n' };
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend, {
      getHalt: () =>
        calls++ >= 2 ? { action: 'terminate', rule: 'hot-loop', reason: 'script ran hot' } : null,
    });
    const result = await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('script ran hot');
    }
  });

  it(`call ${SCRIPT_CALLS_PER_EXECUTION + 1} fails with the cap error but the script still prints and exits`, async () => {
    const responses: ExecRpcResponse[] = [];
    const backend = makeRpcBackend(async function* (call) {
      for (let i = 1; i <= SCRIPT_CALLS_PER_EXECUTION + 1; i++) {
        responses.push(await call('worker', { i }));
      }
      const failed = responses.filter((r) => !r.ok).length;
      yield { stream: 'stdout', data: `done ok=${responses.length - failed} failed=${failed}\n` };
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend);
    const result = await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    // The cap failed the CALL, not the container: the script printed and exited 0.
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBe(`done ok=${SCRIPT_CALLS_PER_EXECUTION} failed=1`);
    const over = responses.at(-1);
    expect(over?.ok).toBe(false);
    expect(over?.code).toBe('per_execution_cap');
  });

  it('framed executions pass an empty env — no host secrets cross the boundary (Lane F pin)', async () => {
    const backend = makeRpcBackend(async function* () {
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend);
    await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    expect(backend.lastOpts?.env).toEqual({});
  });

  it('inner-call events are namespaced under the run_code parent id (Lane E)', async () => {
    const backend = makeRpcBackend(async function* (call) {
      await call('worker', { i: 1 });
      await call('worker', { i: 2 });
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx, events, progress } = makeHarness(backend);
    await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    const starts = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_start' }> => e.type === 'tool_start',
    );
    const ends = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end',
    );
    expect(starts.map((e) => e.toolCallId)).toEqual(['parent-1#1', 'parent-1#2']);
    expect(ends.map((e) => e.toolCallId)).toEqual(['parent-1#1', 'parent-1#2']);
    for (const e of [...starts, ...ends]) expect(e.audience).toBe('internal');
    // Below the threshold: no user-visible progress.
    expect(progress.filter((p) => p.audience === 'user')).toEqual([]);
  });

  it(`emits ONE user-visible progress when an execution crosses 10 inner calls (Lane E)`, async () => {
    const backend = makeRpcBackend(async function* (call) {
      for (let i = 1; i <= 12; i++) await call('worker', { i });
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx, progress } = makeHarness(backend);
    await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    const userProgress = progress.filter((p) => p.audience === 'user');
    expect(userProgress).toHaveLength(1);
    expect(userProgress[0]?.toolName).toBe('run_code');
    expect(userProgress[0]?.message).toContain('10+ tool calls in code');
  });

  it('a canary from an excluded credential tool never crosses the rpc seam (Lane F)', async () => {
    const CANARY = 'CANARY-xyzzy-SECRET';
    const responses: ExecRpcResponse[] = [];
    const backend = makeRpcBackend(async function* (call) {
      responses.push(await call('get_session_events', { sessionId: 'any' }));
      yield { stream: 'stdout', data: 'done\n' };
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend, {
      extraTools: [
        stubTool('get_session_events', {
          toolset: 'debug',
          execute: async () => ({ ok: true, value: CANARY }),
        }),
      ],
      allowedTools: ['run_code', 'worker', 'get_session_events'],
    });
    const result = await tools.get('run_code')?.execute({ runtime: 'python', code: 'x' }, ctx);
    expect(result?.ok).toBe(true);
    // The script saw the exclusion error, never the canary — these response
    // objects are the exact payloads the host writes into rpc_response frames.
    expect(responses).toHaveLength(1);
    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error).toContain('excluded category: credentials');
    expect(JSON.stringify(responses)).not.toContain(CANARY);
  });

  it('the run_code result entering history never exceeds its 10k cap regardless of script output', async () => {
    const backend = makeRpcBackend(async function* () {
      yield { stream: 'stdout', data: 'z'.repeat(50_000) };
      yield { stream: 'exit', code: 0 };
    });
    const { tools, ctx } = makeHarness(backend);
    const [res] = await tools.executeParallel(
      [{ toolCallId: 't1', name: 'run_code', args: { runtime: 'python', code: 'x' } }],
      ctx,
      ['run_code', 'worker'],
    );
    expect(res?.result.ok).toBe(true);
    if (res?.result.ok) {
      expect(res.result.value.length).toBeLessThanOrEqual(10_100);
      expect(res.result.value).toContain('[truncated — 50000 chars total]');
    }
  });
});
